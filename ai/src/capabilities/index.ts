/**
 * The capability layer, in one import.
 *
 * Split three ways to keep the import graph acyclic: `types.ts` is the
 * contract, `catalogue.ts` is the list of capabilities this build has, and
 * `register.ts` walks the list. `register` needs the list, so the list cannot
 * live here — this file imports all three and nothing imports it back.
 */

export * from "./types.ts";
export { CAPABILITIES } from "./catalogue.ts";
export { registerCapabilities, type CapabilityWiring } from "./register.ts";
