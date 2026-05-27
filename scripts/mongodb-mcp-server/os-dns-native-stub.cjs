/**
 * Stub for `os-dns-native` used by the bundler.
 *
 * `os-dns-native` loads a native `.node` addon via the `bindings` package. esbuild
 * cannot bundle that native binary, so the real module ends up as a broken/empty
 * object inside bundle.cjs. `@mongodb-js/devtools-connect` then reads
 * `osDns.withNodeFallback.resolveSrv` (undefined) and throws while resolving
 * `mongodb+srv://` SRV records, surfacing as "configured connection string is not valid".
 *
 * This stub provides the same surface devtools-connect uses, backed entirely by
 * Node's built-in `dns`. Resolution is never "native", so `wasNativelyLookedUp`
 * always returns false.
 */
const dns = require("dns");

const withNodeFallback = {
  resolve: (...args) => dns.resolve(...args),
  resolve4: (...args) => dns.resolve4(...args),
  resolve6: (...args) => dns.resolve6(...args),
  resolveCname: (...args) => dns.resolveCname(...args),
  resolveSrv: (...args) => dns.resolveSrv(...args),
  resolveTxt: (...args) => dns.resolveTxt(...args),
  promises: {
    resolve: (...args) => dns.promises.resolve(...args),
    resolve4: (...args) => dns.promises.resolve4(...args),
    resolve6: (...args) => dns.promises.resolve6(...args),
    resolveCname: (...args) => dns.promises.resolveCname(...args),
    resolveSrv: (...args) => dns.promises.resolveSrv(...args),
    resolveTxt: (...args) => dns.promises.resolveTxt(...args),
  },
};

module.exports = {
  resolve: (...args) => dns.resolve(...args),
  resolve4: (...args) => dns.resolve4(...args),
  resolve6: (...args) => dns.resolve6(...args),
  resolveCname: (...args) => dns.resolveCname(...args),
  resolveSrv: (...args) => dns.resolveSrv(...args),
  resolveTxt: (...args) => dns.resolveTxt(...args),
  promises: { ...dns.promises },
  withNodeFallback,
  wasNativelyLookedUp: () => false,
};
