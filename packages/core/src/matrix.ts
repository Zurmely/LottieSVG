import type { Vec2 } from './types.js';

/** 2D affine matrix [a, b, c, d, e, f] (SVG convention: x' = a x + c y + e, y' = b x + d y + f). */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

export function applyVector(m: Matrix, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];
}

export function isIdentity(m: Matrix, eps = 1e-9): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < eps);
}

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
export function rotate(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}
export const skewX = (deg: number): Matrix => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
export const skewY = (deg: number): Matrix => [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
