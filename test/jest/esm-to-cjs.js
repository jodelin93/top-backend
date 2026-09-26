/**
 * Jest transformer for ESM-only packages in node_modules (@nestjs/typeorm,
 * @nestjs/config, ...). The app itself loads them through Node's native
 * require(esm), but Jest's module loader only supports that on Node 24.9+,
 * so we transpile them to CommonJS on the fly.
 *
 * Some of these files recreate `require` with createRequire(import.meta.url);
 * in CommonJS `require` already exists (and redeclaring it is a syntax error),
 * so that line is dropped before transpiling.
 */
const crypto = require('crypto');
const ts = require('typescript');

const CREATE_REQUIRE = /^const require = createRequire\(import\.meta\.url\);$/m;

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(
      sourceText.replace(CREATE_REQUIRE, ''),
      {
        fileName: sourcePath,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          allowJs: true,
          esModuleInterop: true,
        },
      },
    );
    return { code: outputText };
  },

  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update('esm-to-cjs-v1')
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },
};
