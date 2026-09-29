// Tests run the TypeScript sources directly; bundler-style `./x.js` imports
// point at `./x.ts` files, which Node's type stripping doesn't remap.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}`),
);
