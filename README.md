# SMARTSLOP
SMARTS Linter and Outcome Predictor - a WebAssembly tool for validating reaction SMARTS templates and scoring their predicted outcomes against expected products.

## What it does

Given a set of reactant SMILES, one or more expected product SMILES, and a reaction SMARTS template, SMARTSLOP:

1. **Lints** the reaction SMARTS in Rust before any RDKit call. Specifically it:
   - Rejects empty input and templates missing the `>>` separator.
   - Rejects templates with an empty reactant or product side.
   - Warns when the template has no atom maps at all (unmapped templates almost always generate unrelated products).
   - Warns when a `:n` atom map appears on the product side but not the reactant side (RDKit will invent a new atom).
   - Warns when a `:n` atom map appears on the reactant side but not the product side (the atom will be dropped from every generated product).
   - Warns when a SMILES input has extra lines.
   Errors block evaluation; warnings surface next to the run controls.
2. **Renders reactants and expected products live** with the atoms and bonds that bind to the SMARTS fragments highlighted in orange, updating on every keystroke.
3. **Enumerates outcomes** with RDKit's `run_reactants` across every reactant permutation, canonicalises the resulting products, and dedupes by product multiset.
4. **Scores outcomes** against the expected products: exact match, partial match, or no match, with a percentage score and per-outcome breakdown.
5. **Balance-checks** heavy atoms between reactants and expected products, and reports directional imbalance ("N atoms on the reactant side with no matching product atom - missing byproducts?" vs. the equivalent for the product side).

Everything runs client-side. There is no server.

## Running it

```bash
# Install deps
npm install

# Dev server with hot rebuild (Trunk + wasm-pack)
npm run dev

# One-off release build to dist/
npm run build:web

# Node-side regression harness (rebuilds pkg-node, runs 6 assertions)
npm run verify:rdkit-bridge
```

Trunk serves the compiled Rust wasm plus the JS glue at http://127.0.0.1:8080.

## Input format

The reactant and expected-product textareas take **one SMILES per line**. An optional label follows the first whitespace on the line:

```
COC=CC(=C)O[Si](C)(C)C Danishefsky's diene
O=C1C=CC(=O)C=C1 p-benzoquinone
```

Labels show up in the reaction diagram cells and outcome table. SMILES fragments joined by `.` are treated as a single multi-component molecule (which is what `.` means in SMILES).

The reaction SMARTS field expects a standard atom-mapped SMARTS in the form `reactants>>products`, e.g.

```
[C:1]=[C:2][C:3]=[C:4].[C:5]=[C:6]>>[C:1]1[C:2]=[C:3][C:4][C:5][C:6]1
```

Atom mapping is optional but strongly recommended - the linter uses it to detect dropped or newly introduced atoms.

## Architecture

```
+---------------------+       +--------------------------+
|   index.html + JS   |<----->|  Rust wasm (smartslop-   |
|   (browser UI)      |       |  wasm) - schema + lint   |
+----------+----------+       +-----------+--------------+
           |                              |
           | passes RDKit adapter fn      | validates request,
           v                              v awaits adapter promise
+---------------------+       +--------------------------+
|  RDKit.js (wasm)    |<------|  js/reaction-analysis    |
|  in the browser     |       |  (permutations, scoring, |
+---------------------+       |  highlighting)           |
                              +--------------------------+
```

- `src/` - Rust crate compiled to wasm via `wasm-pack`. Owns request DTOs, schema validation, and the JS adapter dispatch.
- `js/reaction-analysis.mjs` - the RDKit-facing analysis module. Used by both the Node verify harness and the browser.
- `web/main.js` - browser glue: input parsing, debounced live preview, submit handling, and DOM rendering.
- `web/rdkit-browser.mjs` - loads the RDKit wasm bundle from `vendor/rdkit/` and exposes browser-side adapter and preview helpers.
- `scripts/verify-rdkit-bridge.mjs` - Node harness that exercises the same analysis pipeline against a handful of canonical reactions.

## License

See [LICENSE](LICENSE).

