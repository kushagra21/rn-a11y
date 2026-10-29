import { textContrast } from "./contrast.js";
import { controlName, duplicateName, emptyStop, imageName, inputName, missingRole, redundantRole } from "./names.js";
import { platformTargetSize, targetSize } from "./target-size.js";
import type { Rule } from "./types.js";

export const RULES: Rule[] = [
  controlName,
  inputName,
  imageName,
  emptyStop,
  missingRole,
  targetSize,
  platformTargetSize,
  textContrast,
  redundantRole,
  duplicateName,
];

export type { Rule, RuleContext } from "./types.js";
