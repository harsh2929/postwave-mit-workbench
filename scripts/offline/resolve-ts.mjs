/**
 * Module resolve hook for the dependency-free offline test runner.
 *
 * The SDK source imports siblings as `./x.js` (the specifier its bundler and
 * tsc resolve to `./x.ts`). Node's native TypeScript support loads `.ts`
 * files but does not rewrite specifiers, so a relative `.js` import that
 * does not exist on disk is retried as `.ts`. Nothing else is changed.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code === "ERR_MODULE_NOT_FOUND" &&
      /^\.{1,2}\//.test(specifier) &&
      specifier.endsWith(".js")
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
