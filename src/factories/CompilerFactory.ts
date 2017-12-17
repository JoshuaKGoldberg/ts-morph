﻿import * as ts from "typescript";
import * as compiler from "./../compiler";
import * as errors from "./../errors";
import {SourceFileStructure} from "./../structures";
import {KeyValueCache, Logger, FileUtils, EventContainer, createHashSet, ArrayUtils} from "./../utils";
import {GlobalContainer} from "./../GlobalContainer";
import {Directory, VirtualFileSystemHost} from "./../fileSystem";
import {createWrappedNode} from "./../createWrappedNode";
import {nodeToWrapperMappings} from "./nodeToWrapperMappings";
import {ForgetfulNodeCache} from "./ForgetfulNodeCache";
import {DirectoryCache} from "./DirectoryCache";

/**
 * Factory for creating compiler wrappers.
 * @internal
 */
export class CompilerFactory {
    private readonly sourceFileCacheByFilePath = new KeyValueCache<string, compiler.SourceFile>();
    private readonly nodeCache = new ForgetfulNodeCache();
    private readonly directoryCache: DirectoryCache;
    private readonly sourceFileAddedEventContainer = new EventContainer();
    private readonly sourceFileRemovedEventContainer = new EventContainer();

    /**
     * Initializes a new instance of CompilerFactory.
     * @param global - Global container.
     */
    constructor(private readonly global: GlobalContainer) {
        this.directoryCache = new DirectoryCache(global);
    }

    /**
     * Gets the source files from the internal cache.
     */
    getSourceFiles() {
        return ArrayUtils.from(this.sourceFileCacheByFilePath.getValues());
    }

    /**
     * Gets the source file paths from the internal cache.
     */
    getSourceFilePaths() {
        return ArrayUtils.from(this.sourceFileCacheByFilePath.getKeys());
    }

    /**
     * Occurs when a source file is added to the cache.
     * @param subscription - Subscripton.
     */
    onSourceFileAdded(subscription: () => void) {
        this.sourceFileAddedEventContainer.subscribe(subscription);
    }

    /**
     * Occurs when a source file is removed from the cache.
     * @param subscription - Subscripton.
     */
    onSourceFileRemoved(subscription: () => void) {
        this.sourceFileRemovedEventContainer.subscribe(subscription);
    }

    /**
     * Adds a source file by structure or text.
     * @param filePath - File path.
     * @param structureOrText - Structure or text.
     */
    createSourceFile(filePath: string, structureOrText?: string | SourceFileStructure) {
        if (structureOrText == null || typeof structureOrText === "string")
            return this.createSourceFileFromText(filePath, structureOrText || "");

        const sourceFile = this.createSourceFileFromText(filePath, "");
        sourceFile.fill(structureOrText);
        return sourceFile;
    }

    /**
     * Creates a source file from a file path and text.
     * Adds it to the cache.
     * @param filePath - File path for the source file.
     * @param sourceText - Text to create the source file with.
     */
    createSourceFileFromText(filePath: string, sourceText: string) {
        const absoluteFilePath = FileUtils.getStandardizedAbsolutePath(filePath);
        if (this.containsSourceFileAtPath(absoluteFilePath))
            throw new errors.InvalidOperationError(`A source file already exists at the provided file path: ${absoluteFilePath}`);
        const compilerSourceFile = ts.createSourceFile(absoluteFilePath, sourceText, this.global.manipulationSettings.getScriptTarget(), true);
        return this.getSourceFile(compilerSourceFile);
    }

    /**
     * Creates a temporary source file that won't be added to the language service.
     * @param sourceText - Text to create the source file with.
     * @param filePath - File path to use.
     * @returns Wrapped source file.
     */
    createTempSourceFileFromText(sourceText: string, opts: { filePath?: string; createLanguageService?: boolean; } = {}) {
        const {filePath = "tsSimpleAstTempFile.ts", createLanguageService = false} = opts;
        const globalContainer = new GlobalContainer(new VirtualFileSystemHost(), this.global.compilerOptions, { createLanguageService });
        return globalContainer.compilerFactory.createSourceFileFromText(filePath, sourceText);
    }

    /**
     * Gets a source file from a file path. Will use the file path cache if the file exists.
     * @param filePath - File path to get the file from.
     */
    getSourceFileFromFilePath(filePath: string): compiler.SourceFile | undefined {
        const absoluteFilePath = FileUtils.getStandardizedAbsolutePath(filePath);
        let sourceFile = this.sourceFileCacheByFilePath.get(absoluteFilePath);
        if (sourceFile == null) {
            if (this.global.fileSystem.fileExistsSync(absoluteFilePath)) {
                Logger.log(`Loading file: ${absoluteFilePath}`);
                sourceFile = this.createSourceFileFromText(absoluteFilePath, this.global.fileSystem.readFileSync(absoluteFilePath));
                sourceFile.setIsSaved(true); // source files loaded from the disk are saved to start with
            }

            if (sourceFile != null) {
                // ensure these are added to the ast
                sourceFile.getReferencedFiles();
                sourceFile.getTypeReferenceDirectives();
            }
        }

        return sourceFile;
    }

    /**
     * Gets if the internal cache contains a source file at a specific file path.
     * @param filePath - File path to check.
     */
    containsSourceFileAtPath(filePath: string) {
        const absoluteFilePath = FileUtils.getStandardizedAbsolutePath(filePath);
        return this.sourceFileCacheByFilePath.get(absoluteFilePath) != null;
    }

    /**
     * Gets if the internal cache contains a source file with the specified directory path.
     * @param dirPath - Directory path to check.
     */
    containsFileInDirectory(dirPath: string) {
        const normalizedDirPath = FileUtils.getStandardizedAbsolutePath(dirPath);
        return this.directoryCache.has(normalizedDirPath);
    }

    /**
     * Gets the source file for a node.
     * @param compilerNode - Compiler node to get the source file of.
     */
    getSourceFileForNode(compilerNode: ts.Node) {
        let currentNode = compilerNode;
        while (currentNode.kind !== ts.SyntaxKind.SourceFile) {
            if (currentNode.parent == null)
                throw new errors.NotImplementedError("Could not find node source file.");
            currentNode = currentNode.parent;
        }
        return this.getSourceFile(currentNode as ts.SourceFile);
    }

    /**
     * Gets if the factory contains the compiler node in its internal cache.
     * @param compilerNode - Compiler node.
     */
    hasCompilerNode(compilerNode: ts.Node) {
        return this.nodeCache.has(compilerNode);
    }

    /**
     * Gets an existing node from the cache.
     * @param compilerNode - Compiler node.
     */
    getExistingCompilerNode(compilerNode: ts.Node) {
        return this.nodeCache.get(compilerNode);
    }

    /**
     * Gets a wrapped compiler type based on the node's kind.
     * @param node - Node to get the wrapped object from.
     */
    getNodeFromCompilerNode<NodeType extends ts.Node>(compilerNode: NodeType, sourceFile: compiler.SourceFile): compiler.Node<NodeType> {
        if (compilerNode.kind === ts.SyntaxKind.SourceFile)
            return this.getSourceFile(compilerNode as any as ts.SourceFile) as compiler.Node as compiler.Node<NodeType>;

        const createNode = (ctor: any) => {
            // ensure the parent is created
            if (compilerNode.parent != null && !this.nodeCache.has(compilerNode.parent))
                this.getNodeFromCompilerNode(compilerNode.parent, sourceFile);
            return new ctor(this.global, compilerNode, sourceFile);
        };

        if (nodeToWrapperMappings[compilerNode.kind] != null)
            return this.nodeCache.getOrCreate<compiler.Node<NodeType>>(compilerNode, () => createNode(nodeToWrapperMappings[compilerNode.kind]));
        else
            return this.nodeCache.getOrCreate<compiler.Node<NodeType>>(compilerNode, () => createNode(compiler.Node));
    }

    /**
     * Gets a wrapped source file from a compiler source file.
     * @param sourceFile - Compiler source file.
     */
    getSourceFile(compilerSourceFile: ts.SourceFile): compiler.SourceFile {
        return this.nodeCache.getOrCreate<compiler.SourceFile>(compilerSourceFile, () => {
            const sourceFile = new compiler.SourceFile(this.global, compilerSourceFile);
            this.sourceFileCacheByFilePath.set(sourceFile.getFilePath(), sourceFile);

            // add to list of directories
            const dirPath = FileUtils.getStandardizedAbsolutePath(FileUtils.getDirPath(sourceFile.getFilePath()));
            this.directoryCache.addIfNotExists(dirPath);
            this.directoryCache.get(dirPath)!._addSourceFile(sourceFile);

            // fire the event
            this.sourceFileAddedEventContainer.fire(undefined);

            return sourceFile;
        });
    }

    /**
     * Creates a directory if it doesn't exist.
     * @param dirPath - Directory path.
     */
    createDirectoryIfNotExists(dirPath: string) {
        return this.directoryCache.addIfNotExists(dirPath);
    }

    /**
     * Gets a directory.
     * @param dirPath - Directory path.
     */
    getDirectory(dirPath: string) {
        return this.directoryCache.get(dirPath);
    }

    /**
     * Gets the directories without a parent.
     */
    getOrphanDirectories() {
        return this.directoryCache.getOrphans();
    }

    /**
     * Gets a warpped symbol display part form a compiler symbol display part.
     * @param compilerObject - Compiler symbol display part.
     */
    getSymbolDisplayPart(compilerObject: ts.SymbolDisplayPart) {
        return new compiler.SymbolDisplayPart(compilerObject);
    }

    /**
     * Gets a wrapped type from a compiler type.
     * @param type - Compiler type.
     */
    getType(type: ts.Type): compiler.Type {
        return new compiler.Type(this.global, type);
    }

    /**
     * Gets a warpped type parameter from a compiler type parameter.
     * @param typeParameter - Compiler type parameter
     */
    getTypeParameter(typeParameter: ts.TypeParameter): compiler.TypeParameter {
        return new compiler.TypeParameter(this.global, typeParameter);
    }

    /**
     * Gets a wrapped signature from a compiler signature.
     * @param signature - Compiler signature.
     */
    getSignature(signature: ts.Signature): compiler.Signature {
        return new compiler.Signature(this.global, signature);
    }

    /**
     * Gets a wrapped symbol from a compiler symbol.
     * @param symbol - Compiler symbol.
     */
    getSymbol(symbol: ts.Symbol): compiler.Symbol {
        return new compiler.Symbol(this.global, symbol);
    }

    /**
     * Gets a wrapped diagnostic from a compiler diagnostic.
     * @param diagnostic - Compiler diagnostic.
     */
    getDiagnostic(diagnostic: ts.Diagnostic): compiler.Diagnostic {
        return new compiler.Diagnostic(this.global, diagnostic);
    }

    /**
     * Gets a wrapped diagnostic message chain from a compiler diagnostic message chain.
     * @param diagnostic - Compiler diagnostic message chain.
     */
    getDiagnosticMessageChain(diagnosticMessageChain: ts.DiagnosticMessageChain): compiler.DiagnosticMessageChain {
        return new compiler.DiagnosticMessageChain(this.global, diagnosticMessageChain);
    }

    /**
     * Gets a warpped JS doc tag info from a compiler object.
     * @param jsDocTagInfo - Compiler object.
     */
    getJSDocTagInfo(jsDocTagInfo: ts.JSDocTagInfo): compiler.JSDocTagInfo {
        return new compiler.JSDocTagInfo(jsDocTagInfo);
    }

    /**
     * Replaces a compiler node in the cache.
     * @param oldNode - Old node to remove.
     * @param newNode - New node to use.
     */
    replaceCompilerNode(oldNode: ts.Node | compiler.Node, newNode: ts.Node) {
        const nodeToReplace = oldNode instanceof compiler.Node ? oldNode.compilerNode : oldNode;
        const node = oldNode instanceof compiler.Node ? oldNode : this.nodeCache.get(oldNode);

        this.nodeCache.replaceKey(nodeToReplace, newNode);

        if (node != null)
            node.replaceCompilerNodeFromFactory(newNode);
    }

    /**
     * Removes a node from the cache.
     * @param node - Node to remove.
     */
    removeNodeFromCache(node: compiler.Node) {
        const compilerNode = node.compilerNode;
        this.nodeCache.removeByKey(compilerNode);

        if (compilerNode.kind === ts.SyntaxKind.SourceFile) {
            const sourceFile = compilerNode as ts.SourceFile;
            this.directoryCache.get(FileUtils.getDirPath(sourceFile.fileName))!._removeSourceFile(sourceFile.fileName);
            this.sourceFileCacheByFilePath.removeByKey(sourceFile.fileName);
            this.sourceFileRemovedEventContainer.fire(undefined);
        }
    }

    /**
     * Removes the directory from the cache.
     * @param directory - Directory.
     */
    removeDirectoryFromCache(directory: Directory) {
        this.directoryCache.remove(directory.getPath());
    }

    /**
     * Forgets the nodes created in the block.
     * @param block - Block of code to run.
     */
    forgetNodesCreatedInBlock(block: (remember: (...node: compiler.Node[]) => void) => void) {
        this.nodeCache.setForgetPoint();
        try {
            block((...nodes) => {
                for (const node of nodes)
                    this.nodeCache.rememberNode(node);
            });
        } finally {
            this.nodeCache.forgetLastPoint();
        }
    }
}
