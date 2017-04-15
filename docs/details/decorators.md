---
title: Decorators
---

## Decorators

Decorators can be retrieved from class related nodes by calling the `.getDecorators()` property.

```typescript
const decorators = classDeclaration.getDecorators();
const decorator = decorators[0]; // first decorator, if one exists
```

### Name

You can get the name or fully qualified name of a decorator by using the `getName()` or `getFullName()` functions respectively.

For example, given the following code:

```typescript
@obj.decorator
function myFunction() {
}
```

The following happens:

```typescript
decorator.getName(); // decorator
decorator.getFullName(); // obj.decorator
```

### Decorator factory

Decorators with parenthesis (ex. `@decorator(3)`) are decorator factories, while decorators without (ex. `@decorator`) are not.

```typescript
decorator.isDecoratorFactory(); // returns: boolean
```

### Arguments

Decorators with parenthesis are call expressions. Call expressions are currently not implemented in this library,
but you can still access this information through the compiler AST.

The `.getCompilerCallExpression()` method provides this conveniently for you:

```typescript
// must be a decorator factory, otherwise getCompilerCallExpression will return undefined
if (!decorators.isDecoratorFactory())
    return;

const callExpression = decorator.getCompilerCallExpression()!; // ts.CallExpression | undefined
for (let arg of callExpression.arguments) {
    // use arg here
}
```