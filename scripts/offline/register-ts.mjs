/**
 * `--import` entry for the offline runner: installs resolve-ts.mjs.
 * See README "Focused offline lifecycle checks".
 */
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
