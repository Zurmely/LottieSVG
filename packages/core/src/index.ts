export { convertSvg } from './convert.js';
export { toDotLottie, fromDotLottie, type DotLottieOptions } from './dotlottie.js';
export { parsePathData } from './path.js';
export { parseColor } from './color.js';
export { parseTransformList, toComponents, decompose, componentsToMatrix } from './transform.js';
export type {
  ConversionResult,
  ConversionStats,
  ConversionWarning,
  ConvertOptions,
  LottieAnimation,
  WarningSeverity,
} from './types.js';
