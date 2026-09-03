/**
 * `jsonpatch`, in the unit suite.
 *
 * core/document.js, core/persistence.js, core/patchFormat.js and core/arrayControls.js all
 * read a `jsonpatch` global. In the app that global is published by core/vendorGlobals.js,
 * which is not imported here: it also installs jQuery and select2, and those want a DOM.
 * So this puts the same library under the same name, and nothing under test can tell.
 *
 * It used to evaluate the library's browser build through `node:vm`, because the page
 * loaded it as a classic script and there was no package to import. There is one now.
 */
import * as jsonpatch from 'fast-json-patch';

globalThis.jsonpatch = jsonpatch;
