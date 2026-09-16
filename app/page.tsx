'use client';

/* Large binary layer buffers are intentionally kept in refs and mutated inside
   explicit document transactions to avoid cloning megabytes during render. */
/* eslint-disable react-hooks/refs, react-hooks/immutability, react-hooks/exhaustive-deps */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import HelpDialog from './help-dialog';
import AboutDialog from './about-dialog';
import NumericInput, { validateNumericInputs } from './numeric-input';

type ShapeKind = 'circle' | 'triangle' | 'rectangle';
type ParametricKind = ShapeKind | 'text' | 'grating';
type Tool = 'shape' | 'draw' | 'erase' | 'select' | 'move';
type BooleanOperation = 'set1' | 'set0' | 'xor';
type SizeUnit = 'px' | 'mm';
type GratingWriteMode = 'cover' | 'lines';
type GratingPolarity = 'line1' | 'line0';
type TextFont = 'sans' | 'serif' | 'mono';
type TextWeight = '400' | '700';
type TextAlignment = 'left' | 'center' | 'right';
type MatrixView = 'cells' | 'text';
type MatrixScope = 'layer' | 'selection';
type LayerFill = 0 | 1 | 2;
type Point = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type Selection = { x: number; y: number; width: number; height: number };
type BinaryBlock = { width: number; height: number; pixels: Uint8Array };
type MovePreview = BinaryBlock & Point & { source: Selection };
type Quote = { content: string; source: string };
type Layer = { id: string; name: string; pixels: Uint8Array; visible: boolean; locked: boolean };
type LayerSnapshot = Omit<Layer, 'pixels'> & { pixels: Uint8Array };
type HistorySnapshot = { layers: LayerSnapshot[]; activeLayerId: string; selectedLayerIds: string[] };
type ShapeSpec = { kind: ShapeKind; centerX: number; centerY: number; sizeX: number; sizeY: number; projection: number; rotation: number };
type TransformSpec = { centerX: number; centerY: number; rotation: number };
type TextSpec = TransformSpec & { content: string; fontSize: number; font: TextFont; weight: TextWeight; lineHeight: number; letterSpacing: number; alignment: TextAlignment };
type GratingSpec = TransformSpec & { width: number; height: number; period: number; duty: number; phase: number };
type TextRun = { text: string; x: number; baseline: number };
type TextLayout = { runs: TextRun[]; bounds: Bounds; width: number; height: number };
type ProjectPayload = {
  format: 'binary-mask-studio'; version: 1; width: number; height: number; dpi: number; activeLayerId: string;
  layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; pixels: string }>;
};

const TRANSPARENT = 0;
const OPAQUE_ZERO = 1;
const OPAQUE_ONE = 2;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_DPI = 300;
const MAX_DIMENSION = 4096;
const MIN_ZOOM = 2;
const MAX_ZOOM = 1600;
const HISTORY_BYTE_LIMIT = 128 * 1024 * 1024;
const MATRIX_COLUMNS = 16;
const MATRIX_ROWS = 10;
const TEXT_FONTS: Record<TextFont, string> = {
  sans: '"Microsoft YaHei", "Noto Sans SC", Arial, sans-serif',
  serif: 'SimSun, "Songti SC", "Noto Serif SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

const BUILT_IN_QUOTES: Quote[] = [
  { content: '行到水穷处，坐看云起时。', source: '王维《终南别业》' },
  { content: '无边落木萧萧下，不尽长江滚滚来。', source: '杜甫《登高》' },
  { content: '十年生死两茫茫，不思量，自难忘。', source: '苏轼《江城子·乙卯正月二十日夜记梦》' },
  { content: '知不可乎骤得，托遗响于悲风。', source: '苏轼《赤壁赋》' },
  { content: '后之视今，亦犹今之视昔，悲夫！', source: '王羲之《兰亭集序》' },
];

function makeId(prefix = 'layer') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createLayer(width: number, height: number, name: string, fill: LayerFill = TRANSPARENT): Layer {
  const pixels = new Uint8Array(width * height);
  if (fill !== TRANSPARENT) pixels.fill(fill);
  return { id: makeId(), name, pixels, visible: true, locked: false };
}

function cloneLayer(layer: Layer): LayerSnapshot {
  return { ...layer, pixels: new Uint8Array(layer.pixels) };
}

function toPixels(value: number, unit: SizeUnit, dpi: number) {
  return unit === 'px' ? value : (value / 25.4) * dpi;
}

function fromPixels(value: number, unit: SizeUnit, dpi: number) {
  return unit === 'px' ? value : (value / dpi) * 25.4;
}

function localToWorld(point: Point, spec: TransformSpec): Point {
  const theta = (spec.rotation * Math.PI) / 180;
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  return { x: spec.centerX + point.x * cosine + point.y * sine, y: spec.centerY - point.x * sine + point.y * cosine };
}

function worldToLocal(x: number, y: number, spec: TransformSpec): Point {
  const theta = (spec.rotation * Math.PI) / 180;
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  const dx = x - spec.centerX;
  const dy = y - spec.centerY;
  return { x: dx * cosine - dy * sine, y: dx * sine + dy * cosine };
}

function triangleVertices(spec: ShapeSpec): [Point, Point, Point] {
  const centroidX = (spec.sizeX + spec.projection) / 3;
  return [
    { x: -centroidX, y: spec.sizeY / 3 },
    { x: spec.sizeX - centroidX, y: spec.sizeY / 3 },
    { x: spec.projection - centroidX, y: (-2 * spec.sizeY) / 3 },
  ];
}

function insideTriangle(point: Point, vertices: [Point, Point, Point]) {
  const sign = (p: Point, a: Point, b: Point) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d1 = sign(point, vertices[0], vertices[1]);
  const d2 = sign(point, vertices[1], vertices[2]);
  const d3 = sign(point, vertices[2], vertices[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function isInsideShape(x: number, y: number, spec: ShapeSpec) {
  const point = worldToLocal(x, y, spec);
  if (spec.kind === 'circle') {
    const radiusX = spec.sizeX / 2;
    const radiusY = spec.sizeY / 2;
    if (radiusX <= 0 || radiusY <= 0) return false;
    return (point.x * point.x) / (radiusX * radiusX) + (point.y * point.y) / (radiusY * radiusY) <= 1;
  }
  if (spec.kind === 'rectangle') return Math.abs(point.x) <= spec.sizeX / 2 && Math.abs(point.y) <= spec.sizeY / 2;
  return insideTriangle(point, triangleVertices(spec));
}

function shapeBounds(spec: ShapeSpec): Bounds {
  if (spec.kind === 'circle') {
    const theta = (spec.rotation * Math.PI) / 180;
    const radiusX = spec.sizeX / 2;
    const radiusY = spec.sizeY / 2;
    const extentX = Math.sqrt((radiusX * Math.cos(theta)) ** 2 + (radiusY * Math.sin(theta)) ** 2);
    const extentY = Math.sqrt((radiusX * Math.sin(theta)) ** 2 + (radiusY * Math.cos(theta)) ** 2);
    return { minX: spec.centerX - extentX, maxX: spec.centerX + extentX, minY: spec.centerY - extentY, maxY: spec.centerY + extentY };
  }
  const localPoints = spec.kind === 'triangle' ? triangleVertices(spec) : [
    { x: -spec.sizeX / 2, y: -spec.sizeY / 2 }, { x: spec.sizeX / 2, y: -spec.sizeY / 2 },
    { x: spec.sizeX / 2, y: spec.sizeY / 2 }, { x: -spec.sizeX / 2, y: spec.sizeY / 2 },
  ];
  const points = localPoints.map((point) => localToWorld(point, spec));
  return {
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

function pixelBounds(bounds: Bounds, width: number, height: number) {
  const theoreticalMinX = Math.ceil(bounds.minX - 0.5);
  const theoreticalMaxX = Math.floor(bounds.maxX - 0.5);
  const theoreticalMinY = Math.ceil(bounds.minY - 0.5);
  const theoreticalMaxY = Math.floor(bounds.maxY - 0.5);
  const minX = Math.max(0, theoreticalMinX);
  const maxX = Math.min(width - 1, theoreticalMaxX);
  const minY = Math.max(0, theoreticalMinY);
  const maxY = Math.min(height - 1, theoreticalMaxY);
  return { minX, maxX, minY, maxY, theoreticalMinX, theoreticalMaxX, theoreticalMinY, theoreticalMaxY, hasIntersection: minX <= maxX && minY <= maxY };
}

function writeShape(pixels: Uint8Array, width: number, height: number, spec: ShapeSpec, operation: BooleanOperation) {
  const range = pixelBounds(shapeBounds(spec), width, height);
  if (!range.hasIntersection) return 0;
  let touched = 0;
  for (let y = range.minY; y <= range.maxY; y += 1) for (let x = range.minX; x <= range.maxX; x += 1) {
    if (!isInsideShape(x + 0.5, y + 0.5, spec)) continue;
    const index = y * width + x;
    if (operation === 'set1') pixels[index] = OPAQUE_ONE;
    else if (operation === 'set0') pixels[index] = OPAQUE_ZERO;
    else pixels[index] = pixels[index] === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
    touched += 1;
  }
  return touched;
}

function setTextFont(context: CanvasRenderingContext2D, spec: TextSpec) {
  context.font = `${spec.weight} ${Math.max(0.5, spec.fontSize)}px ${TEXT_FONTS[spec.font]}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

function measureTextLayout(context: CanvasRenderingContext2D, spec: TextSpec): TextLayout {
  setTextFont(context, spec);
  const lines = spec.content.replace(/\r\n?/g, '\n').split('\n');
  const fontSize = Math.max(0.5, spec.fontSize);
  const lineAdvance = Math.max(0.5, fontSize * Math.max(0.1, spec.lineHeight));
  const letterSpacing = Math.max(-fontSize * 0.9, spec.letterSpacing);
  const characterLines = lines.map((line) => Array.from(line));
  const lineWidths = characterLines.map((characters, index) => {
    if (Math.abs(letterSpacing) < 0.001) return context.measureText(lines[index]).width;
    return Math.max(0, characters.reduce((sum, character) => sum + context.measureText(character).width, 0) + Math.max(0, characters.length - 1) * letterSpacing);
  });
  const blockWidth = Math.max(0, ...lineWidths);
  const blockHeight = fontSize + Math.max(0, lines.length - 1) * lineAdvance;
  const blockTop = -blockHeight / 2;
  const runs: TextRun[] = [];
  let minX = -blockWidth / 2;
  let maxX = blockWidth / 2;
  let minY = blockTop;
  let maxY = blockTop + blockHeight;

  lines.forEach((line, lineIndex) => {
    const lineWidth = lineWidths[lineIndex];
    const startX = spec.alignment === 'left' ? -blockWidth / 2 : spec.alignment === 'right' ? blockWidth / 2 - lineWidth : -lineWidth / 2;
    const baseline = blockTop + fontSize * 0.8 + lineIndex * lineAdvance;
    if (Math.abs(letterSpacing) < 0.001) {
      runs.push({ text: line, x: startX, baseline });
      const metrics = context.measureText(line);
      minX = Math.min(minX, startX - (metrics.actualBoundingBoxLeft || 0));
      maxX = Math.max(maxX, startX + (metrics.actualBoundingBoxRight || lineWidth));
      minY = Math.min(minY, baseline - (metrics.actualBoundingBoxAscent || fontSize * 0.8));
      maxY = Math.max(maxY, baseline + (metrics.actualBoundingBoxDescent || fontSize * 0.2));
      return;
    }
    let x = startX;
    characterLines[lineIndex].forEach((character, characterIndex) => {
      const metrics = context.measureText(character);
      runs.push({ text: character, x, baseline });
      minX = Math.min(minX, x - (metrics.actualBoundingBoxLeft || 0));
      maxX = Math.max(maxX, x + (metrics.actualBoundingBoxRight || metrics.width));
      minY = Math.min(minY, baseline - (metrics.actualBoundingBoxAscent || fontSize * 0.8));
      maxY = Math.max(maxY, baseline + (metrics.actualBoundingBoxDescent || fontSize * 0.2));
      x += metrics.width + (characterIndex < characterLines[lineIndex].length - 1 ? letterSpacing : 0);
    });
  });
  return { runs, bounds: { minX, maxX, minY, maxY }, width: blockWidth, height: blockHeight };
}

function drawTextLayout(context: CanvasRenderingContext2D, layout: TextLayout, mode: 'fill' | 'stroke') {
  for (const run of layout.runs) {
    if (mode === 'fill') context.fillText(run.text, run.x, run.baseline);
    else context.strokeText(run.text, run.x, run.baseline);
  }
}

function transformedBounds(bounds: Bounds, spec: TransformSpec): Bounds {
  const points = [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ].map((point) => localToWorld(point, spec));
  return {
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

function gratingBounds(spec: GratingSpec): Bounds {
  return transformedBounds({ minX: -spec.width / 2, maxX: spec.width / 2, minY: -spec.height / 2, maxY: spec.height / 2 }, spec);
}

function isGratingLine(localX: number, spec: GratingSpec) {
  if (spec.duty <= 0) return false;
  if (spec.duty >= 100) return true;
  const wrapped = (((localX - spec.phase + spec.period / 2) % spec.period) + spec.period) % spec.period - spec.period / 2;
  const halfLineWidth = (spec.period * spec.duty) / 200;
  return wrapped >= -halfLineWidth && wrapped < halfLineWidth;
}

function writeGrating(pixels: Uint8Array, width: number, height: number, spec: GratingSpec, mode: GratingWriteMode, polarity: GratingPolarity, operation: BooleanOperation) {
  const range = pixelBounds(gratingBounds(spec), width, height);
  if (!range.hasIntersection || spec.width <= 0 || spec.height <= 0 || spec.period <= 0) return 0;
  let touched = 0;
  for (let y = range.minY; y <= range.maxY; y += 1) for (let x = range.minX; x <= range.maxX; x += 1) {
    const local = worldToLocal(x + 0.5, y + 0.5, spec);
    if (Math.abs(local.x) > spec.width / 2 || Math.abs(local.y) > spec.height / 2) continue;
    const line = isGratingLine(local.x, spec);
    const index = y * width + x;
    if (mode === 'cover') {
      const valueIsOne = polarity === 'line1' ? line : !line;
      pixels[index] = valueIsOne ? OPAQUE_ONE : OPAQUE_ZERO;
    } else {
      if (!line) continue;
      if (operation === 'set1') pixels[index] = OPAQUE_ONE;
      else if (operation === 'set0') pixels[index] = OPAQUE_ZERO;
      else pixels[index] = pixels[index] === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
    }
    touched += 1;
  }
  return touched;
}

function drawGratingPreview(context: CanvasRenderingContext2D, spec: GratingSpec, mode: GratingWriteMode, polarity: GratingPolarity, operation: BooleanOperation, outside: boolean) {
  const halfWidth = spec.width / 2;
  const halfHeight = spec.height / 2;
  const lineWidth = (spec.period * spec.duty) / 100;
  context.save();
  context.beginPath(); context.rect(-halfWidth, -halfHeight, spec.width, spec.height); context.clip();
  context.globalAlpha = 0.72;
  if (mode === 'cover') {
    context.fillStyle = polarity === 'line1' ? '#000' : '#fff';
    context.fillRect(-halfWidth, -halfHeight, spec.width, spec.height);
  }
  if (spec.duty > 0) {
    const firstIndex = Math.floor((-halfWidth - spec.phase - lineWidth / 2) / spec.period) - 1;
    const lastIndex = Math.ceil((halfWidth - spec.phase + lineWidth / 2) / spec.period) + 1;
    const lineCount = lastIndex - firstIndex + 1;
    context.fillStyle = mode === 'cover' ? (polarity === 'line1' ? '#fff' : '#000') : operation === 'set1' ? '#fff' : operation === 'set0' ? '#000' : '#c7ff3d';
    if (lineCount <= 4096) {
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const lineCenter = spec.phase + index * spec.period;
        context.fillRect(lineCenter - lineWidth / 2, -halfHeight, lineWidth, spec.height);
      }
    } else {
      context.globalAlpha = mode === 'cover' ? 0.34 : 0.22;
      context.fillRect(-halfWidth, -halfHeight, spec.width, spec.height);
    }
  }
  context.restore();
  context.strokeStyle = outside ? '#ff776e' : '#c7ff3d';
  context.strokeRect(-halfWidth, -halfHeight, spec.width, spec.height);
}

function measureTextBounds(spec: TextSpec): Bounds {
  if (typeof document === 'undefined') return { minX: spec.centerX, maxX: spec.centerX, minY: spec.centerY, maxY: spec.centerY };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { minX: spec.centerX, maxX: spec.centerX, minY: spec.centerY, maxY: spec.centerY };
  return transformedBounds(measureTextLayout(context, spec).bounds, spec);
}

function writeText(pixels: Uint8Array, width: number, height: number, spec: TextSpec, operation: BooleanOperation) {
  const measuredBounds = measureTextBounds(spec);
  const paddedBounds = { minX: measuredBounds.minX - 2, maxX: measuredBounds.maxX + 2, minY: measuredBounds.minY - 2, maxY: measuredBounds.maxY + 2 };
  const range = pixelBounds(paddedBounds, width, height);
  if (!range.hasIntersection) return 0;
  const scratch = document.createElement('canvas');
  scratch.width = range.maxX - range.minX + 1;
  scratch.height = range.maxY - range.minY + 1;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (!context) return 0;
  context.translate(spec.centerX - range.minX, spec.centerY - range.minY);
  context.rotate((-spec.rotation * Math.PI) / 180);
  const layout = measureTextLayout(context, spec);
  context.fillStyle = '#fff';
  drawTextLayout(context, layout, 'fill');
  context.setTransform(1, 0, 0, 1, 0, 0);
  const image = context.getImageData(0, 0, scratch.width, scratch.height).data;
  let touched = 0;
  for (let y = 0; y < scratch.height; y += 1) for (let x = 0; x < scratch.width; x += 1) {
    if (image[(y * scratch.width + x) * 4 + 3] < 128) continue;
    const index = (range.minY + y) * width + range.minX + x;
    if (operation === 'set1') pixels[index] = OPAQUE_ONE;
    else if (operation === 'set0') pixels[index] = OPAQUE_ZERO;
    else pixels[index] = pixels[index] === OPAQUE_ONE ? OPAQUE_ZERO : OPAQUE_ONE;
    touched += 1;
  }
  return touched;
}

function compositeLayers(layers: Layer[], width: number, height: number) {
  const pixels = new Uint8Array(width * height);
  const resolved = new Uint8Array(width * height);
  for (const layer of layers) {
    if (!layer.visible) continue;
    for (let index = 0; index < layer.pixels.length; index += 1) {
      if (resolved[index] || layer.pixels[index] === TRANSPARENT) continue;
      pixels[index] = layer.pixels[index] === OPAQUE_ONE ? 1 : 0;
      resolved[index] = 1;
    }
  }
  return { pixels, resolved };
}

function regionToText(pixels: Uint8Array, canvasWidth: number, region: Selection) {
  const rows: string[] = [];
  for (let y = 0; y < region.height; y += 1) {
    const values = new Array<string>(region.width);
    for (let x = 0; x < region.width; x += 1) {
      const value = pixels[(region.y + y) * canvasWidth + region.x + x];
      values[x] = value === OPAQUE_ONE ? '1' : value === OPAQUE_ZERO ? '0' : '·';
    }
    rows.push(values.join(' '));
  }
  return rows.join('\n');
}

function parseMatrixText(text: string, allowTransparent: boolean) {
  const cleaned = text.trim().replace(/^\s*\[/, '').replace(/\]\s*$/, '');
  const lines = cleaned.split(/[;\r\n]+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('没有检测到矩阵内容。');
  const rows = lines.map((line, rowIndex) => {
    const compact = line.replace(/[\s,]/g, '');
    const compactPattern = allowTransparent ? /^[01.·]+$/ : /^[01]+$/;
    const values = compactPattern.test(compact) ? compact.split('') : line.split(/[\s,]+/).filter(Boolean);
    const valid = values.every((value) => value === '0' || value === '1' || (allowTransparent && (value === '.' || value === '·')));
    if (!values.length || !valid) throw new Error(`第 ${rowIndex + 1} 行包含不支持的内容。`);
    return values.map((value) => value === '1' ? OPAQUE_ONE : value === '0' ? OPAQUE_ZERO : TRANSPARENT);
  });
  const matrixWidth = rows[0].length;
  if (rows.some((row) => row.length !== matrixWidth)) throw new Error('矩阵每一行的列数必须相同。');
  if (matrixWidth > MAX_DIMENSION || rows.length > MAX_DIMENSION) throw new Error(`矩阵不得超过 ${MAX_DIMENSION} × ${MAX_DIMENSION}。`);
  return rows;
}

function layerToText(pixels: Uint8Array, width: number, height: number) {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const values = new Array<string>(width);
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x];
      values[x] = value === OPAQUE_ONE ? '1' : value === OPAQUE_ZERO ? '0' : '·';
    }
    rows.push(values.join(' '));
  }
  return rows.join('\n');
}

function binaryToText(pixels: Uint8Array, width: number, height: number, separator: string) {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const values = new Array<string>(width);
    for (let x = 0; x < width; x += 1) values[x] = pixels[y * width + x] ? '1' : '0';
    rows.push(values.join(separator));
  }
  return rows.join('\n');
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uint32(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  return concatBytes([uint32(data.length), typeBytes, data, uint32(crc32(concatBytes([typeBytes, data])))]);
}

async function encodeOneBitPng(mask: Uint8Array, width: number, height: number, dpi: number) {
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const targetRow = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) if (mask[y * width + x]) raw[targetRow + 1 + (x >> 3)] |= 1 << (7 - (x & 7));
  }
  const compressedStream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const header = concatBytes([uint32(width), uint32(height), new Uint8Array([1, 0, 0, 0, 0])]);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const physical = concatBytes([uint32(pixelsPerMeter), uint32(pixelsPerMeter), new Uint8Array([1])]);
  return new Blob([concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('pHYs', physical), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array()),
  ])], { type: 'image/png' });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function LinkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.2 13.8a4.5 4.5 0 0 0 6.4.1l2.3-2.3a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3" /><path d="M13.8 10.2a4.5 4.5 0 0 0-6.4-.1l-2.3 2.3a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3" /></svg>;
}

function EyeIcon({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? 'M2.6 12s3.5-6 9.4-6 9.4 6 9.4 6-3.5 6-9.4 6-9.4-6-9.4-6Z' : 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5.9 0 9.4 6 9.4 6a15.7 15.7 0 0 1-2.2 2.9M6.2 6.2C3.9 8 2.6 12 2.6 12s3.5 6 9.4 6c1.4 0 2.6-.3 3.7-.8'} /><circle cx="12" cy="12" r="2.5" /></svg>;
}

function LockIcon({ locked }: { locked: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d={locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M16 10V7a4 4 0 0 0-7.7-1.5'} /></svg>;
}

function FitIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></svg>;
}

function randomBuiltInQuote() {
  return BUILT_IN_QUOTES[Math.floor(Math.random() * BUILT_IN_QUOTES.length)];
}

async function fetchRandomQuote() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2800);
  try {
    const response = await fetch('https://v1.jinrishici.com/all.json', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as { content?: unknown; author?: unknown; origin?: unknown };
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    const author = typeof data.author === 'string' ? data.author.trim() : '';
    const origin = typeof data.origin === 'string' ? data.origin.trim() : '';
    if (!content || content.length > 72 || (!author && !origin)) return null;
    return { content, source: `${author}${origin ? `《${origin}》` : ''}` } satisfies Quote;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function LayerThumbnail({ layer, width, height, version }: { layer: Layer; width: number; height: number; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x / canvas.width) * width));
      const sourceY = Math.min(height - 1, Math.floor((y / canvas.height) * height));
      const state = layer.pixels[sourceY * width + sourceX];
      const index = (y * canvas.width + x) * 4;
      const checker = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 ? 222 : 244;
      const value = state === OPAQUE_ONE ? 255 : state === OPAQUE_ZERO ? 0 : checker;
      image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value; image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [height, layer, version, width]);
  return <canvas ref={ref} width={54} height={32} aria-hidden="true" />;
}

function SectionHeading({ number, title, subtitle }: { number: string; title: string; subtitle: string }) {
  return <div className="panel-heading"><span>{number}</span><div><strong>{title}</strong><small>{subtitle}</small></div></div>;
}

function FieldSuffix({ children }: { children: React.ReactNode }) { return <span className="field-suffix">{children}</span>; }

export default function Home() {
  const initialLayerRef = useRef<Layer | null>(null);
  if (!initialLayerRef.current) {
    const layer = createLayer(DEFAULT_WIDTH, DEFAULT_HEIGHT, '图层 1');
    initialLayerRef.current = layer;
  }
  const layersRef = useRef<Layer[]>([initialLayerRef.current]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const shapeFieldsRef = useRef<HTMLDivElement>(null);
  const newCanvasFieldsRef = useRef<HTMLElement>(null);
  const matrixFieldsRef = useRef<HTMLElement>(null);
  const layerCreateRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const selectionStartRef = useRef<Point | null>(null);
  const panRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const spacePressedRef = useRef(false);
  const dirtyRef = useRef(false);
  const undoRef = useRef<HistorySnapshot[]>([]);
  const redoRef = useRef<HistorySnapshot[]>([]);
  const layerClipboardRef = useRef<LayerSnapshot[]>([]);
  const matrixDraftRef = useRef<Uint8Array | null>(null);
  const pendingZoomAnchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const appliedAutoFitRequestRef = useRef(-1);
  const paintFrameRef = useRef<number | null>(null);
  const queuedQuoteRef = useRef<Quote | null>(null);
  const quoteFetchPendingRef = useRef(false);

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [docVersion, setDocVersion] = useState(1);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeLayerId, setActiveLayerId] = useState(initialLayerRef.current.id);
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([initialLayerRef.current.id]);
  const [layerClipboardVersion, setLayerClipboardVersion] = useState(0);
  const [dragLayerId, setDragLayerId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('shape');
  const [brushSize, setBrushSize] = useState(12);
  const [paintValue, setPaintValue] = useState<0 | 1>(1);
  const [brushDragging, setBrushDragging] = useState(false);
  const [shape, setShape] = useState<ParametricKind>('circle');
  const [centerX, setCenterX] = useState(DEFAULT_WIDTH / 2);
  const [centerY, setCenterY] = useState(DEFAULT_HEIGHT / 2);
  const [dimensionX, setDimensionX] = useState(10);
  const [dimensionY, setDimensionY] = useState(10);
  const [aspectLinked, setAspectLinked] = useState(true);
  const [aspectRatio, setAspectRatio] = useState(1);
  const [triangleBase, setTriangleBase] = useState(100);
  const [triangleHeight, setTriangleHeight] = useState((100 * Math.sqrt(3)) / 2);
  const [triangleProjection, setTriangleProjection] = useState(50);
  const [equilateral, setEquilateral] = useState(true);
  const [textContent, setTextContent] = useState('忽闻海上有仙山 山在虚无缥缈间');
  const [textFontSize, setTextFontSize] = useState(72);
  const [textFont, setTextFont] = useState<TextFont>('sans');
  const [textWeight, setTextWeight] = useState<TextWeight>('700');
  const [textLineHeight, setTextLineHeight] = useState(1.2);
  const [textLetterSpacing, setTextLetterSpacing] = useState(0);
  const [textAlignment, setTextAlignment] = useState<TextAlignment>('center');
  const [gratingWidth, setGratingWidth] = useState(200);
  const [gratingHeight, setGratingHeight] = useState(200);
  const [gratingAspectLinked, setGratingAspectLinked] = useState(true);
  const [gratingAspectRatio, setGratingAspectRatio] = useState(1);
  const [gratingPeriod, setGratingPeriod] = useState(20);
  const [gratingDuty, setGratingDuty] = useState(50);
  const [gratingPhase, setGratingPhase] = useState(0);
  const [gratingWriteMode, setGratingWriteMode] = useState<GratingWriteMode>('cover');
  const [gratingPolarity, setGratingPolarity] = useState<GratingPolarity>('line1');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('px');
  const [rotation, setRotation] = useState(0);
  const [operation, setOperation] = useState<BooleanOperation>('set1');
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<Selection | null>(null);
  const [binaryClipboard, setBinaryClipboard] = useState<BinaryBlock | null>(null);
  const [pastePreview, setPastePreview] = useState<(BinaryBlock & Point) | null>(null);
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [zoom, setZoom] = useState(100);
  const [fitScale, setFitScale] = useState(0.5);
  const [autoFitRequest, setAutoFitRequest] = useState(0);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrixView, setMatrixView] = useState<MatrixView>('cells');
  const [matrixScope, setMatrixScope] = useState<MatrixScope>('layer');
  const [matrixText, setMatrixText] = useState('');
  const [matrixDraftVersion, setMatrixDraftVersion] = useState(0);
  const [matrixStartX, setMatrixStartX] = useState(0);
  const [matrixStartY, setMatrixStartY] = useState(0);
  const [newCanvasOpen, setNewCanvasOpen] = useState(false);
  const [newWidth, setNewWidth] = useState(DEFAULT_WIDTH);
  const [newHeight, setNewHeight] = useState(DEFAULT_HEIGHT);
  const [newDpi, setNewDpi] = useState(DEFAULT_DPI);
  const [layerCreateMenuOpen, setLayerCreateMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [quote, setQuote] = useState<Quote>(BUILT_IN_QUOTES[0]);
  const [dirty, setDirty] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [processing, setProcessing] = useState('');
  const [exportBaseName, setExportBaseName] = useState(`binary-mask-${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}`);
  const [toast, setToast] = useState('已载入 1920 × 1080 示例，可继续编辑或新建画布。');

  const setDocumentDirty = (value: boolean) => { dirtyRef.current = value; setDirty(value); };
  const bumpDocument = (markDirty = true) => { setDocVersion((value) => value + 1); if (markDirty) setDocumentDirty(true); };
  const bumpHistory = () => setHistoryVersion((value) => value + 1);
  const activeLayer = layersRef.current.find((layer) => layer.id === activeLayerId) ?? layersRef.current[0];
  const selectedSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);
  const compositeData = useMemo(() => compositeLayers(layersRef.current, width, height), [docVersion, height, width]);
  const composite = compositeData.pixels;
  const compositeResolved = compositeData.resolved;
  const whitePixels = useMemo(() => { let count = 0; for (const value of composite) count += value; return count; }, [composite]);
  const currentValue = composite[cursor.y * width + cursor.x] ?? 0;
  const physicalWidth = ((width / dpi) * 25.4).toFixed(2);
  const physicalHeight = ((height / dpi) * 25.4).toFixed(2);
  const resolvedTriangleHeight = equilateral ? (triangleBase * Math.sqrt(3)) / 2 : triangleHeight;
  const resolvedTriangleProjection = equilateral ? triangleBase / 2 : triangleProjection;
  const geometryKind: ShapeKind = shape === 'text' || shape === 'grating' ? 'rectangle' : shape;
  const sizeX = toPixels(shape === 'triangle' ? triangleBase : dimensionX, sizeUnit, dpi);
  const sizeY = toPixels(shape === 'triangle' ? resolvedTriangleHeight : dimensionY, sizeUnit, dpi);
  const projection = toPixels(shape === 'triangle' ? resolvedTriangleProjection : 0, sizeUnit, dpi);
  const textFontSizePixels = toPixels(textFontSize, sizeUnit, dpi);
  const textLetterSpacingPixels = toPixels(textLetterSpacing, sizeUnit, dpi);
  const gratingWidthPixels = toPixels(gratingWidth, sizeUnit, dpi);
  const gratingHeightPixels = toPixels(gratingHeight, sizeUnit, dpi);
  const gratingPeriodPixels = toPixels(gratingPeriod, sizeUnit, dpi);
  const gratingPhasePixels = toPixels(gratingPhase, sizeUnit, dpi);
  const shapeSpec = useMemo<ShapeSpec>(() => ({ kind: geometryKind, centerX, centerY, sizeX, sizeY, projection, rotation }), [centerX, centerY, geometryKind, projection, rotation, sizeX, sizeY]);
  const textSpec = useMemo<TextSpec>(() => ({ content: textContent, centerX, centerY, fontSize: textFontSizePixels, font: textFont, weight: textWeight, lineHeight: textLineHeight, letterSpacing: textLetterSpacingPixels, alignment: textAlignment, rotation }), [centerX, centerY, rotation, textAlignment, textContent, textFont, textFontSizePixels, textLetterSpacingPixels, textLineHeight, textWeight]);
  const gratingSpec = useMemo<GratingSpec>(() => ({ centerX, centerY, width: gratingWidthPixels, height: gratingHeightPixels, period: gratingPeriodPixels, duty: gratingDuty, phase: gratingPhasePixels, rotation }), [centerX, centerY, gratingDuty, gratingHeightPixels, gratingPeriodPixels, gratingPhasePixels, gratingWidthPixels, rotation]);
  const geometryBounds = useMemo(() => shapeBounds(shapeSpec), [shapeSpec]);
  const bounds = useMemo(() => shape === 'text' ? measureTextBounds(textSpec) : shape === 'grating' ? gratingBounds(gratingSpec) : geometryBounds, [geometryBounds, gratingSpec, shape, textSpec]);
  const hasParametricContent = shape === 'text' ? Boolean(textContent.trim()) : shape === 'grating' ? gratingWidthPixels > 0 && gratingHeightPixels > 0 && gratingPeriodPixels > 0 : true;
  const gratingAliased = shape === 'grating' && gratingPeriodPixels < 2;
  const gratingCycleCount = gratingPeriodPixels > 0 ? gratingWidthPixels / gratingPeriodPixels : 0;
  const clippedRange = useMemo(() => pixelBounds(bounds, width, height), [bounds, height, width]);
  const partiallyOutside = hasParametricContent && (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > width || bounds.maxY > height);
  const displayBounds = !hasParametricContent ? (shape === 'text' ? '请输入文字' : '参数无效') : clippedRange.hasIntersection ? `X ${clippedRange.minX}～${clippedRange.maxX} · Y ${clippedRange.minY}～${clippedRange.maxY}` : '与画布无交集';
  const parametricLabel = shape === 'text' ? '文字' : shape === 'grating' ? '光栅' : '图形';
  const parametricHint = !hasParametricContent ? (shape === 'text' ? '文字内容不能为空' : '宽度、高度和周期必须大于 0')
    : !clippedRange.hasIntersection ? `${parametricLabel}完全位于画布外`
      : shape === 'grating' ? `${partiallyOutside ? '超出部分将在应用时自动剪切 · ' : ''}周期 ${gratingPeriodPixels.toFixed(2)} px · 约 ${gratingCycleCount.toFixed(2)} 个周期${gratingAliased ? ' · 周期低于 2 px，可能混叠' : ''}`
        : partiallyOutside ? '超出部分将在应用时自动剪切'
          : shape === 'text' ? `字号 ${textFontSizePixels.toFixed(2)} px · 字距 ${textLetterSpacingPixels.toFixed(2)} px`
            : `像素尺寸约 ${sizeX.toFixed(2)} × ${sizeY.toFixed(2)} px`;

  const snapshotCurrent = (): HistorySnapshot => ({ layers: layersRef.current.map(cloneLayer), activeLayerId, selectedLayerIds: [...selectedLayerIds] });
  const snapshotBytes = (snapshot: HistorySnapshot) => snapshot.layers.reduce((sum, layer) => sum + layer.pixels.byteLength, 0);
  const pushHistory = () => {
    undoRef.current.push(snapshotCurrent());
    let total = undoRef.current.reduce((sum, snapshot) => sum + snapshotBytes(snapshot), 0);
    while (total > HISTORY_BYTE_LIMIT && undoRef.current.length > 1) total -= snapshotBytes(undoRef.current.shift()!);
    redoRef.current = []; bumpHistory();
  };
  const restoreSnapshot = (snapshot: HistorySnapshot) => {
    layersRef.current = snapshot.layers.map(cloneLayer);
    const restoredActive = layersRef.current.some((layer) => layer.id === snapshot.activeLayerId) ? snapshot.activeLayerId : layersRef.current[0].id;
    setActiveLayerId(restoredActive);
    const validSelected = snapshot.selectedLayerIds.filter((id) => layersRef.current.some((layer) => layer.id === id));
    setSelectedLayerIds(validSelected.length ? validSelected : [restoredActive]);
    bumpDocument(); bumpHistory();
  };
  const undo = () => { const previous = undoRef.current.pop(); if (!previous) return; redoRef.current.push(snapshotCurrent()); restoreSnapshot(previous); };
  const redo = () => { const next = redoRef.current.pop(); if (!next) return; undoRef.current.push(snapshotCurrent()); restoreSnapshot(next); };
  const requireEditableLayer = () => { if (!activeLayer) return false; if (!activeLayer.locked) return true; setToast('当前图层已锁定，请先解锁。'); return false; };
  const resetHistory = () => { undoRef.current = []; redoRef.current = []; bumpHistory(); };
  const scheduleDocumentBump = () => {
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = window.requestAnimationFrame(() => { paintFrameRef.current = null; bumpDocument(); });
  };
  const withProcessing = async (label: string, task: () => void | Promise<void>) => {
    if (processing) return;
    setProcessing(label);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try { await task(); } finally { setProcessing(''); }
  };
  const prefetchRandomQuote = () => {
    if (quoteFetchPendingRef.current || queuedQuoteRef.current) return;
    quoteFetchPendingRef.current = true;
    void fetchRandomQuote().then((onlineQuote) => { if (onlineQuote) queuedQuoteRef.current = onlineQuote; }).finally(() => { quoteFetchPendingRef.current = false; });
  };
  const openInfoWindow = (kind: 'help' | 'about') => {
    setQuote(queuedQuoteRef.current ?? randomBuiltInQuote());
    queuedQuoteRef.current = null;
    if (kind === 'help') setHelpOpen(true); else setAboutOpen(true);
    prefetchRandomQuote();
  };

  useEffect(() => () => { if (paintFrameRef.current !== null) window.cancelAnimationFrame(paintFrameRef.current); }, []);
  useEffect(() => { prefetchRandomQuote(); }, []);
  useEffect(() => {
    if (!layerCreateMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => { if (!layerCreateRef.current?.contains(event.target as Node)) setLayerCreateMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setLayerCreateMenuOpen(false); };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', closeOnOutsidePointer, true); window.removeEventListener('keydown', closeOnEscape); };
  }, [layerCreateMenuOpen]);
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return;
    const image = context.createImageData(width, height);
    for (let index = 0; index < composite.length; index += 1) {
      const pixelX = index % width; const pixelY = Math.floor(index / width);
      const checker = (Math.floor(pixelX / 12) + Math.floor(pixelY / 12)) % 2 ? 212 : 239;
      const value = compositeResolved[index] ? (composite[index] ? 255 : 0) : checker; const target = index * 4;
      image.data[target] = value; image.data[target + 1] = value; image.data[target + 2] = value; image.data[target + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [composite, compositeResolved, height, width]);

  useEffect(() => {
    const canvas = overlayRef.current; if (!canvas) return;
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, width, height);
    context.lineWidth = Math.max(1.5, width / 900);
    context.setLineDash([Math.max(5, width / 240), Math.max(4, width / 300)]);
    if (tool === 'shape' && hasParametricContent) {
      context.save(); context.translate(centerX, centerY); context.rotate((-rotation * Math.PI) / 180);
      if (shape === 'text') {
        const layout = measureTextLayout(context, textSpec);
        context.setLineDash([]);
        context.lineWidth = Math.max(1, textFontSizePixels / 64);
        context.strokeStyle = partiallyOutside ? '#ff776e' : '#c7ff3d';
        context.fillStyle = operation === 'set0' ? 'rgba(0,0,0,.78)' : operation === 'xor' ? 'rgba(199,255,61,.58)' : 'rgba(255,255,255,.82)';
        drawTextLayout(context, layout, 'stroke');
        drawTextLayout(context, layout, 'fill');
        context.setLineDash([Math.max(5, width / 240), Math.max(4, width / 300)]);
        context.lineWidth = Math.max(1.5, width / 900);
        context.strokeRect(layout.bounds.minX, layout.bounds.minY, layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxY - layout.bounds.minY);
      } else if (shape === 'grating') {
        drawGratingPreview(context, gratingSpec, gratingWriteMode, gratingPolarity, operation, partiallyOutside);
      } else {
        context.strokeStyle = partiallyOutside ? '#ff776e' : '#c7ff3d'; context.beginPath();
        if (shape === 'circle') context.ellipse(0, 0, sizeX / 2, sizeY / 2, 0, 0, Math.PI * 2);
        else if (shape === 'rectangle') context.rect(-sizeX / 2, -sizeY / 2, sizeX, sizeY);
        else { const vertices = triangleVertices(shapeSpec); context.moveTo(vertices[0].x, vertices[0].y); context.lineTo(vertices[1].x, vertices[1].y); context.lineTo(vertices[2].x, vertices[2].y); context.closePath(); }
        context.stroke();
      }
      context.restore();
    }
    const activeSelection = selectionDraft ?? selection;
    if (activeSelection) {
      context.save(); context.fillStyle = 'rgba(20,37,31,.13)';
      context.fillRect(0, 0, width, activeSelection.y);
      context.fillRect(0, activeSelection.y + activeSelection.height, width, height - activeSelection.y - activeSelection.height);
      context.fillRect(0, activeSelection.y, activeSelection.x, activeSelection.height);
      context.fillRect(activeSelection.x + activeSelection.width, activeSelection.y, width - activeSelection.x - activeSelection.width, activeSelection.height);
      context.strokeStyle = '#c7ff3d'; context.fillStyle = 'rgba(199,255,61,.06)';
      context.fillRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height);
      context.strokeRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height); context.restore();
    }
    if (pastePreview) {
      const temporary = document.createElement('canvas'); temporary.width = pastePreview.width; temporary.height = pastePreview.height;
      const temporaryContext = temporary.getContext('2d');
      if (temporaryContext) {
        const image = temporaryContext.createImageData(pastePreview.width, pastePreview.height);
        for (let index = 0; index < pastePreview.pixels.length; index += 1) {
          const state = pastePreview.pixels[index]; const target = index * 4;
          if (state === TRANSPARENT) { image.data[target + 3] = 0; continue; }
          const value = state === OPAQUE_ONE ? 255 : 0;
          image.data[target] = value; image.data[target + 1] = value; image.data[target + 2] = value; image.data[target + 3] = 190;
        }
        temporaryContext.putImageData(image, 0, 0); context.drawImage(temporary, pastePreview.x, pastePreview.y);
      }
      context.save(); context.strokeStyle = '#ff8b7f'; context.strokeRect(pastePreview.x, pastePreview.y, pastePreview.width, pastePreview.height); context.restore();
    }
    if (movePreview) {
      const temporary = document.createElement('canvas'); temporary.width = movePreview.width; temporary.height = movePreview.height;
      const temporaryContext = temporary.getContext('2d');
      if (temporaryContext) {
        const image = temporaryContext.createImageData(movePreview.width, movePreview.height);
        for (let index = 0; index < movePreview.pixels.length; index += 1) {
          const state = movePreview.pixels[index]; const target = index * 4;
          if (state === TRANSPARENT) { image.data[target + 3] = 0; continue; }
          const value = state === OPAQUE_ONE ? 255 : 0;
          image.data[target] = value; image.data[target + 1] = value; image.data[target + 2] = value; image.data[target + 3] = 220;
        }
        temporaryContext.putImageData(image, 0, 0); context.drawImage(temporary, movePreview.x, movePreview.y);
      }
      context.save(); context.strokeStyle = '#ff8b7f'; context.strokeRect(movePreview.x, movePreview.y, movePreview.width, movePreview.height); context.restore();
    }
    if ((tool === 'draw' || tool === 'erase') && !pastePreview && !movePreview) {
      const radius = Math.max(.5, brushSize / 2);
      context.save(); context.setLineDash([]); context.lineWidth = Math.max(1, width / 1200);
      context.beginPath(); context.arc(cursor.x + .5, cursor.y + .5, radius, 0, Math.PI * 2); context.strokeStyle = '#fff'; context.stroke();
      context.lineWidth *= 2.6; context.globalCompositeOperation = 'destination-over'; context.strokeStyle = '#111'; context.stroke(); context.globalCompositeOperation = 'source-over';
      context.beginPath(); context.arc(cursor.x + .5, cursor.y + .5, Math.max(1.5, Math.min(radius * .32, width / 220)), 0, Math.PI * 2);
      context.fillStyle = tool === 'erase' ? 'rgba(255,255,255,.78)' : paintValue ? '#fff' : '#000'; context.fill(); context.strokeStyle = tool === 'erase' ? '#d6574d' : paintValue ? '#111' : '#fff'; context.lineWidth = Math.max(1, width / 1500); context.stroke();
      if (tool === 'erase') { context.beginPath(); context.moveTo(cursor.x - radius * .34, cursor.y + radius * .34); context.lineTo(cursor.x + radius * .34, cursor.y - radius * .34); context.strokeStyle = '#d6574d'; context.stroke(); }
      context.restore();
    }
  }, [brushSize, centerX, centerY, cursor, gratingPolarity, gratingSpec, gratingWriteMode, hasParametricContent, height, movePreview, operation, paintValue, partiallyOutside, pastePreview, rotation, selection, selectionDraft, shape, shapeSpec, sizeX, sizeY, textFontSizePixels, textSpec, tool, width]);

  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const calculate = () => {
      const availableWidth = Math.max(180, stage.clientWidth - 116); const availableHeight = Math.max(180, stage.clientHeight - 108);
      const nextFitScale = Math.max(0.02, Math.min(1, availableWidth / width, availableHeight / height));
      setFitScale(nextFitScale);
      if (appliedAutoFitRequestRef.current !== autoFitRequest) {
        appliedAutoFitRequestRef.current = autoFitRequest;
        const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(nextFitScale * 100)));
        setZoom(nextZoom);
      }
    };
    calculate(); const observer = new ResizeObserver(calculate); observer.observe(stage); return () => observer.disconnect();
  }, [autoFitRequest, height, width]);
  const displayWidth = Math.max(1, width * (zoom / 100));
  const displayHeight = Math.max(1, height * (zoom / 100));
  useEffect(() => {
    const anchor = pendingZoomAnchorRef.current; const stage = stageRef.current; const frame = canvasFrameRef.current;
    if (!anchor || !stage || !frame) return;
    const rect = frame.getBoundingClientRect();
    stage.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
    stage.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
    pendingZoomAnchorRef.current = null;
  }, [displayHeight, displayWidth, zoom]);

  const pointerToPixel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * width))), y: Math.max(0, Math.min(height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * height))) };
  };
  const paintPoint = (x: number, y: number) => {
    if (!activeLayer) return; const radius = Math.max(0.5, brushSize / 2);
    const minX = Math.max(0, Math.floor(x - radius)); const maxX = Math.min(width - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius)); const maxY = Math.min(height - 1, Math.ceil(y + radius));
    for (let py = minY; py <= maxY; py += 1) for (let px = minX; px <= maxX; px += 1) {
      if ((px - x) ** 2 + (py - y) ** 2 > radius ** 2) continue;
      if (selection && (px < selection.x || px >= selection.x + selection.width || py < selection.y || py >= selection.y + selection.height)) continue;
      activeLayer.pixels[py * width + px] = tool === 'erase' ? TRANSPARENT : paintValue ? OPAQUE_ONE : OPAQUE_ZERO;
    }
  };
  const paintSegment = (from: Point, to: Point) => {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let step = 0; step <= steps; step += 1) paintPoint(Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps));
    scheduleDocumentBump();
  };
  const selectionFromPoints = (start: Point, end: Point): Selection => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x) + 1, height: Math.abs(start.y - end.y) + 1 });

  const selectAll = () => { setSelection({ x: 0, y: 0, width, height }); setTool('select'); };
  const deselect = () => { setSelection(null); setSelectionDraft(null); setMovePreview(null); };
  const clearSelection = () => {
    if (!selection || !requireEditableLayer()) return;
    pushHistory();
    for (let y = selection.y; y < selection.y + selection.height; y += 1) activeLayer.pixels.fill(TRANSPARENT, y * width + selection.x, y * width + selection.x + selection.width);
    bumpDocument(); setToast('当前图层选区已清除为透明。');
  };
  const beginMove = () => {
    if (!selection) { setToast('请先创建一个矩形选区。'); return; }
    if (!requireEditableLayer()) return;
    const pixels = new Uint8Array(selection.width * selection.height);
    for (let y = 0; y < selection.height; y += 1) pixels.set(activeLayer.pixels.subarray((selection.y + y) * width + selection.x, (selection.y + y) * width + selection.x + selection.width), y * selection.width);
    setMovePreview({ ...selection, source: selection, pixels }); setPastePreview(null); setTool('move');
  };
  const confirmMove = () => {
    if (!movePreview || !requireEditableLayer()) return false;
    pushHistory();
    const source = movePreview.source;
    for (let y = source.y; y < source.y + source.height; y += 1) activeLayer.pixels.fill(TRANSPARENT, y * width + source.x, y * width + source.x + source.width);
    for (let sy = 0; sy < movePreview.height; sy += 1) for (let sx = 0; sx < movePreview.width; sx += 1) {
      const x = movePreview.x + sx; const y = movePreview.y + sy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      activeLayer.pixels[y * width + x] = movePreview.pixels[sy * movePreview.width + sx];
    }
    setSelection(null);
    setMovePreview(null); bumpDocument(); setToast('选区内容已在当前图层内移动，越界部分已剪切。');
    return true;
  };

  const activateTool = (nextTool: Tool) => {
    // Finish a move and release its selection before painting.
    if (movePreview && !confirmMove()) return;
    setPastePreview(null);
    setMovePreview(null);
    selectionStartRef.current = null;
    setSelectionDraft(null);
    drawingRef.current = false;
    lastPointRef.current = null;
    setTool(nextTool);
  };

  const confirmPaste = () => {
    if (!pastePreview || !requireEditableLayer()) return;
    const minX = Math.max(0, pastePreview.x); const minY = Math.max(0, pastePreview.y);
    const maxX = Math.min(width - 1, pastePreview.x + pastePreview.width - 1); const maxY = Math.min(height - 1, pastePreview.y + pastePreview.height - 1);
    if (minX > maxX || minY > maxY) { setToast('粘贴块完全位于画布外，无法确认。'); return; }
    pushHistory();
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const sourceX = x - pastePreview.x; const sourceY = y - pastePreview.y;
      activeLayer.pixels[y * width + x] = pastePreview.pixels[sourceY * pastePreview.width + sourceX];
    }
    setSelection(null);
    setPastePreview(null); bumpDocument(); setToast('矩阵块已覆盖写入当前图层。');
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerToPixel(event); setCursor(point);
    if (event.button === 1 || spacePressedRef.current) {
      const stage = stageRef.current; if (!stage) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { clientX: event.clientX, clientY: event.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
      return;
    }
    if (pastePreview) return;
    if (movePreview) return;
    if (tool === 'shape' || tool === 'move') return;
    if (tool === 'select') { event.currentTarget.setPointerCapture(event.pointerId); selectionStartRef.current = point; setSelectionDraft({ x: point.x, y: point.y, width: 1, height: 1 }); return; }
    if (!requireEditableLayer()) return;
    event.currentTarget.setPointerCapture(event.pointerId); pushHistory(); drawingRef.current = true; lastPointRef.current = point; paintSegment(point, point);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerToPixel(event); setCursor(point);
    if (panRef.current) {
      const stage = stageRef.current; if (!stage) return;
      stage.scrollLeft = panRef.current.scrollLeft - (event.clientX - panRef.current.clientX);
      stage.scrollTop = panRef.current.scrollTop - (event.clientY - panRef.current.clientY);
      return;
    }
    if (pastePreview) { setPastePreview((preview) => preview ? { ...preview, x: point.x, y: point.y } : null); return; }
    if (movePreview) { setMovePreview((preview) => preview ? { ...preview, x: point.x, y: point.y } : null); return; }
    if (selectionStartRef.current) { setSelectionDraft(selectionFromPoints(selectionStartRef.current, point)); return; }
    if (!drawingRef.current || !lastPointRef.current) return;
    paintSegment(lastPointRef.current, point); lastPointRef.current = point;
  };
  const stopPointerAction = () => { panRef.current = null; drawingRef.current = false; lastPointRef.current = null; if (selectionStartRef.current && selectionDraft) setSelection(selectionDraft); selectionStartRef.current = null; setSelectionDraft(null); };
  const copySelection = () => {
    if (!selection) { setToast('请先创建一个矩形选区。'); return; }
    const pixels = new Uint8Array(selection.width * selection.height);
    for (let y = 0; y < selection.height; y += 1) for (let x = 0; x < selection.width; x += 1) {
      const sourceIndex = (selection.y + y) * width + selection.x + x;
      pixels[y * selection.width + x] = compositeResolved[sourceIndex] ? (composite[sourceIndex] ? OPAQUE_ONE : OPAQUE_ZERO) : TRANSPARENT;
    }
    setBinaryClipboard({ width: selection.width, height: selection.height, pixels }); setToast(`已复制 ${selection.width} × ${selection.height} 的最终可见三态内容。`);
  };
  const beginPaste = () => { if (!binaryClipboard) { setToast('当前没有可粘贴的矩阵块。'); return; } if (!requireEditableLayer()) return; setPastePreview({ ...binaryClipboard, x: cursor.x, y: cursor.y }); setTool('select'); };
  const applyShape = () => {
    if (!validateNumericInputs(shapeFieldsRef.current)) return;
    if (!hasParametricContent) { setToast(shape === 'text' ? '请输入需要写入的文字。' : '光栅宽度、高度和周期必须大于 0。'); return; }
    if (!clippedRange.hasIntersection) { setToast(`${parametricLabel}完全位于画布外，没有可写入的像素。`); return; }
    if (!requireEditableLayer()) return;
    if (shape === 'text') {
      void withProcessing('正在栅格化文字', () => {
        pushHistory();
        const touched = writeText(activeLayer.pixels, width, height, textSpec, operation);
        if (!touched) { undoRef.current.pop(); bumpHistory(); setToast('当前文字在二值化后没有覆盖任何像素。'); return; }
        bumpDocument(); setToast(partiallyOutside ? '文字已自动剪切并写入画布内区域。' : '文字已栅格化写入当前图层。');
      });
      return;
    }
    if (shape === 'grating') {
      void withProcessing('正在生成光栅', () => {
        pushHistory();
        const touched = writeGrating(activeLayer.pixels, width, height, gratingSpec, gratingWriteMode, gratingPolarity, operation);
        if (!touched) { undoRef.current.pop(); bumpHistory(); setToast(gratingDuty <= 0 && gratingWriteMode === 'lines' ? '占空比为 0%，没有可写入的栅线。' : '当前光栅没有覆盖任何采样像素。'); return; }
        bumpDocument(); setToast(partiallyOutside ? '光栅已自动剪切并写入画布内区域。' : '一维线性光栅已写入当前图层。');
      });
      return;
    }
    pushHistory();
    const touched = writeShape(activeLayer.pixels, width, height, shapeSpec, operation);
    if (!touched) { undoRef.current.pop(); bumpHistory(); setToast('当前参数没有覆盖任何像素中心。'); return; }
    bumpDocument(); setToast(partiallyOutside ? '图形已自动剪切并写入画布内区域。' : '精确图形已写入当前图层。');
  };
  const invertActiveLayer = () => { if (!requireEditableLayer()) return; pushHistory(); for (let index = 0; index < activeLayer.pixels.length; index += 1) { if (activeLayer.pixels[index] === OPAQUE_ONE) activeLayer.pixels[index] = OPAQUE_ZERO; else if (activeLayer.pixels[index] === OPAQUE_ZERO) activeLayer.pixels[index] = OPAQUE_ONE; } bumpDocument(); setToast('当前图层的 0 和 1 已反转，透明像素保持不变。'); };
  const clearActiveLayer = () => { if (!requireEditableLayer()) return; pushHistory(); activeLayer.pixels.fill(TRANSPARENT); bumpDocument(); setToast('当前图层已清空为透明。'); };
  const clearAllLayers = () => { if (layersRef.current.some((layer) => layer.locked)) { setToast('存在锁定图层，请先解锁后再清空全部图层。'); return; } if (!window.confirm('确定清空全部图层内容吗？此操作可以撤销。')) return; pushHistory(); layersRef.current.forEach((layer) => layer.pixels.fill(TRANSPARENT)); bumpDocument(); setToast('全部图层已清空为透明。'); };

  const addLayer = (fill: LayerFill) => {
    pushHistory();
    const sequence = layersRef.current.length + 1;
    const name = fill === OPAQUE_ZERO ? `黑色 0 图层 ${sequence}` : fill === OPAQUE_ONE ? `白色 1 图层 ${sequence}` : `图层 ${sequence}`;
    const layer = createLayer(width, height, name, fill);
    const activeIndex = layersRef.current.findIndex((item) => item.id === activeLayerId);
    layersRef.current.splice(Math.max(0, activeIndex), 0, layer);
    setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); setLayerCreateMenuOpen(false); bumpDocument();
    setToast(fill === OPAQUE_ZERO ? '已新建覆盖完整画布的黑色 0 图层。' : fill === OPAQUE_ONE ? '已新建覆盖完整画布的白色 1 图层。' : '已新建透明图层。');
  };
  const duplicateSelectedLayers = () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (!selected.length) return; pushHistory();
    const topIndex = Math.min(...selected.map((layer) => layersRef.current.indexOf(layer)));
    const copies = selected.map((layer) => ({ ...cloneLayer(layer), id: makeId(), name: `${layer.name} 副本`, locked: false }));
    layersRef.current.splice(topIndex, 0, ...copies); setActiveLayerId(copies[0].id); setSelectedLayerIds(copies.map((layer) => layer.id)); bumpDocument();
  };
  const cutSelectedLayers = () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (!selected.length) return;
    if (selected.some((layer) => layer.locked)) { setToast('选中的图层中包含锁定图层，请先解锁。'); return; }
    pushHistory(); layerClipboardRef.current = selected.map(cloneLayer); setLayerClipboardVersion((value) => value + 1);
    layersRef.current = layersRef.current.filter((layer) => !selectedSet.has(layer.id)); if (!layersRef.current.length) layersRef.current = [createLayer(width, height, '图层 1')];
    const next = layersRef.current[0]; setActiveLayerId(next.id); setSelectedLayerIds([next.id]); bumpDocument(); setToast(`已剪切 ${selected.length} 个图层。`);
  };
  const pasteLayers = () => {
    if (!layerClipboardRef.current.length) { setToast('图层剪贴板为空。'); return; } pushHistory();
    const copies: Layer[] = layerClipboardRef.current.map((layer) => ({ ...layer, pixels: new Uint8Array(layer.pixels), id: makeId(), locked: false }));
    const activeIndex = layersRef.current.findIndex((layer) => layer.id === activeLayerId); layersRef.current.splice(Math.max(0, activeIndex), 0, ...copies);
    setActiveLayerId(copies[0].id); setSelectedLayerIds(copies.map((layer) => layer.id)); bumpDocument();
  };
  const deleteSelectedLayers = () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (!selected.length) return;
    if (selected.some((layer) => layer.locked)) { setToast('选中的图层中包含锁定图层，请先解锁。'); return; }
    pushHistory(); layersRef.current = layersRef.current.filter((layer) => !selectedSet.has(layer.id)); if (!layersRef.current.length) layersRef.current = [createLayer(width, height, '图层 1')];
    const next = layersRef.current[0]; setActiveLayerId(next.id); setSelectedLayerIds([next.id]); bumpDocument();
  };
  const mergeSelectedLayers = () => void withProcessing('正在合并图层', async () => {
    const selected = layersRef.current.filter((layer) => selectedSet.has(layer.id)); if (selected.length < 2) return;
    if (selected.some((layer) => layer.locked)) { setToast('选中的图层中包含锁定图层，请先解锁。'); return; }
    pushHistory(); const existingMerged = layersRef.current.filter((layer) => layer.name.startsWith('合并图层')).length;
    const merged = createLayer(width, height, existingMerged ? `合并图层 ${existingMerged + 1}` : '合并图层');
    for (let index = 0; index < merged.pixels.length; index += 1) {
      let hasZero = false; let hasOne = false;
      for (const layer of selected) { if (layer.pixels[index] === OPAQUE_ONE) hasOne = true; else if (layer.pixels[index] === OPAQUE_ZERO) hasZero = true; }
      merged.pixels[index] = hasOne ? OPAQUE_ONE : hasZero ? OPAQUE_ZERO : TRANSPARENT;
    }
    const insertionIndex = Math.min(...selected.map((layer) => layersRef.current.indexOf(layer)));
    layersRef.current = layersRef.current.filter((layer) => !selectedSet.has(layer.id)); layersRef.current.splice(insertionIndex, 0, merged);
    setActiveLayerId(merged.id); setSelectedLayerIds([merged.id]); bumpDocument(); setToast('选中图层已按 1 > 0 > 透明合并。');
  });
  const toggleLayerVisibility = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; pushHistory(); layer.visible = !layer.visible; bumpDocument(); };
  const toggleLayerLock = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; pushHistory(); layer.locked = !layer.locked; bumpDocument(); };
  const renameLayer = (id: string) => { const layer = layersRef.current.find((item) => item.id === id); if (!layer) return; if (layer.locked) { setToast('图层已锁定，请先解锁后再重命名。'); return; } const name = window.prompt('请输入新的图层名称：', layer.name)?.trim(); if (!name || name === layer.name) return; pushHistory(); layer.name = name; bumpDocument(); };
  const selectLayer = (event: React.MouseEvent, id: string) => {
    const index = layersRef.current.findIndex((layer) => layer.id === id); const activeIndex = layersRef.current.findIndex((layer) => layer.id === activeLayerId);
    if (event.shiftKey && activeIndex >= 0) { const start = Math.min(index, activeIndex); const end = Math.max(index, activeIndex); setSelectedLayerIds(layersRef.current.slice(start, end + 1).map((layer) => layer.id)); }
    else if (event.ctrlKey || event.metaKey) {
      if (selectedLayerIds.includes(id)) {
        if (selectedLayerIds.length === 1) return;
        const nextSelection = selectedLayerIds.filter((item) => item !== id);
        setSelectedLayerIds(nextSelection);
        if (activeLayerId === id) setActiveLayerId(nextSelection[0]);
        return;
      }
      setSelectedLayerIds([...selectedLayerIds, id]);
    }
    else setSelectedLayerIds([id]);
    setActiveLayerId(id);
  };
  const moveActiveLayer = (direction: -1 | 1) => { if (selectedLayerIds.length !== 1 || activeLayer.locked) return; const index = layersRef.current.findIndex((layer) => layer.id === activeLayerId); const nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= layersRef.current.length) return; pushHistory(); const [layer] = layersRef.current.splice(index, 1); layersRef.current.splice(nextIndex, 0, layer); bumpDocument(); };
  const dropLayer = (targetId: string) => { if (!dragLayerId || dragLayerId === targetId) return; const sourceIndex = layersRef.current.findIndex((layer) => layer.id === dragLayerId); const source = layersRef.current[sourceIndex]; if (!source || source.locked) return; let targetIndex = layersRef.current.findIndex((layer) => layer.id === targetId); pushHistory(); layersRef.current.splice(sourceIndex, 1); if (sourceIndex < targetIndex) targetIndex -= 1; layersRef.current.splice(targetIndex, 0, source); setDragLayerId(null); bumpDocument(); };

  const openMatrixEditor = () => void withProcessing('正在打开矩阵', async () => {
    matrixDraftRef.current = new Uint8Array(activeLayer.pixels); setMatrixText(''); setMatrixView('cells'); setMatrixScope('layer');
    setMatrixStartX(Math.max(0, Math.min(width - MATRIX_COLUMNS, cursor.x - Math.floor(MATRIX_COLUMNS / 2)))); setMatrixStartY(Math.max(0, Math.min(height - MATRIX_ROWS, cursor.y - Math.floor(MATRIX_ROWS / 2)))); setMatrixDraftVersion((value) => value + 1); setMatrixOpen(true);
  });
  const matrixRegion: Selection = matrixScope === 'selection' && selection ? selection : { x: 0, y: 0, width, height };
  const setMatrixCell = (x: number, y: number, value?: number) => { const draft = matrixDraftRef.current; if (!draft || activeLayer.locked || x < matrixRegion.x || x >= matrixRegion.x + matrixRegion.width || y < matrixRegion.y || y >= matrixRegion.y + matrixRegion.height) return; const index = y * width + x; draft[index] = value ?? (draft[index] === TRANSPARENT ? OPAQUE_ZERO : draft[index] === OPAQUE_ZERO ? OPAQUE_ONE : TRANSPARENT); setMatrixDraftVersion((current) => current + 1); };
  const changeMatrixScope = (scope: MatrixScope) => {
    if (scope === 'selection' && !selection) return;
    const region = scope === 'selection' && selection ? selection : { x: 0, y: 0, width, height };
    setMatrixScope(scope); setMatrixText(''); setMatrixStartX(region.x); setMatrixStartY(region.y);
  };
  const loadMatrixText = () => { if (!matrixDraftRef.current) return; if (matrixRegion.width * matrixRegion.height > 300000 && !window.confirm('当前范围较大，转换为文本可能需要一些时间。是否继续？')) return; setMatrixText(matrixScope === 'selection' ? regionToText(matrixDraftRef.current, width, matrixRegion) : layerToText(matrixDraftRef.current, width, height)); };
  const applyMatrixEditor = () => void withProcessing('正在应用矩阵', async () => {
    if (!validateNumericInputs(matrixFieldsRef.current)) return;
    if (!requireEditableLayer()) return;
    try {
      if (matrixView === 'text') {
        const rows = parseMatrixText(matrixText, true);
        if (rows.length !== matrixRegion.height || rows[0].length !== matrixRegion.width) throw new Error(`当前编辑范围为 ${matrixRegion.width} × ${matrixRegion.height}，输入矩阵必须完全一致。`);
        const draft = matrixDraftRef.current ?? new Uint8Array(activeLayer.pixels);
        rows.forEach((row, y) => row.forEach((value, x) => { draft[(matrixRegion.y + y) * width + matrixRegion.x + x] = value; })); matrixDraftRef.current = draft;
      }
      if (!matrixDraftRef.current) return; pushHistory(); activeLayer.pixels = new Uint8Array(matrixDraftRef.current); setMatrixOpen(false); bumpDocument(); setToast('当前图层矩阵已更新。');
    } catch (error) { setToast(error instanceof Error ? error.message : '矩阵格式无法识别。'); }
  });

  const addImportedLayer = (pixels: Uint8Array, name: string) => { pushHistory(); const layer: Layer = { id: makeId(), name, pixels, visible: true, locked: false }; const activeIndex = layersRef.current.findIndex((item) => item.id === activeLayerId); layersRef.current.splice(Math.max(0, activeIndex), 0, layer); setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); bumpDocument(); };
  const importFile = async (file: File) => {
    try {
      const pixels = new Uint8Array(width * height);
      if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
        const bitmap = await createImageBitmap(file); const temporary = document.createElement('canvas'); temporary.width = bitmap.width; temporary.height = bitmap.height;
        const context = temporary.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('无法读取图片。');
        context.drawImage(bitmap, 0, 0); const sourcePixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const copyWidth = Math.min(width, bitmap.width); const copyHeight = Math.min(height, bitmap.height);
        for (let y = 0; y < copyHeight; y += 1) for (let x = 0; x < copyWidth; x += 1) {
          const source = (y * bitmap.width + x) * 4; if (sourcePixels[source + 3] < 128) continue;
          const luminance = sourcePixels[source] * 0.2126 + sourcePixels[source + 1] * 0.7152 + sourcePixels[source + 2] * 0.0722;
          pixels[y * width + x] = luminance >= 128 ? OPAQUE_ONE : OPAQUE_ZERO;
        }
        bitmap.close();
      } else {
        const rows = parseMatrixText(await file.text(), false); const copyHeight = Math.min(height, rows.length); const copyWidth = Math.min(width, rows[0].length);
        for (let y = 0; y < copyHeight; y += 1) for (let x = 0; x < copyWidth; x += 1) pixels[y * width + x] = rows[y][x];
      }
      addImportedLayer(pixels, file.name.replace(/\.[^.]+$/, '') || '导入图层'); setToast('文件已从左上角对齐导入为新图层，越界部分已剪切。');
    } catch (error) { setToast(error instanceof Error ? error.message : '文件导入失败。'); }
  };
  const safeExportBaseName = (exportBaseName.trim().replace(/\.(png|csv|txt|bmask)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || `binary-mask-${width}x${height}`);
  const saveProject = () => void withProcessing('正在保存工程', async () => {
    const payload: ProjectPayload = { format: 'binary-mask-studio', version: 1, width, height, dpi, activeLayerId, layers: layersRef.current.map((layer) => ({ id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked, pixels: bytesToBase64(layer.pixels) })) };
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${safeExportBaseName}.bmask`); setDocumentDirty(false); setToast('图层工程已保存为 .bmask。');
  });
  const openProject = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as ProjectPayload;
      if (payload.format !== 'binary-mask-studio' || payload.version !== 1) throw new Error('不是受支持的 .bmask 工程文件。');
      if (!Number.isInteger(payload.width) || !Number.isInteger(payload.height) || payload.width < 1 || payload.height < 1 || payload.width > MAX_DIMENSION || payload.height > MAX_DIMENSION) throw new Error('工程中的画布尺寸无效。');
      if (!Number.isFinite(payload.dpi) || payload.dpi < 1 || payload.dpi > 2400) throw new Error('工程中的 DPI 无效。');
      if (!Array.isArray(payload.layers) || !payload.layers.length) throw new Error('工程中没有图层。');
      const expectedLength = payload.width * payload.height;
      const layers = payload.layers.map((item, index) => { const pixels = base64ToBytes(item.pixels); if (pixels.length !== expectedLength || pixels.some((value) => value > OPAQUE_ONE)) throw new Error(`图层 ${index + 1} 的数据损坏。`); return { id: item.id || makeId(), name: item.name || `图层 ${index + 1}`, visible: Boolean(item.visible), locked: Boolean(item.locked), pixels }; });
      layersRef.current = layers; setWidth(payload.width); setHeight(payload.height); setDpi(Math.round(payload.dpi));
      const nextActive = layers.some((layer) => layer.id === payload.activeLayerId) ? payload.activeLayerId : layers[0].id;
      setActiveLayerId(nextActive); setSelectedLayerIds([nextActive]); setCenterX(payload.width / 2); setCenterY(payload.height / 2); setCursor({ x: 0, y: 0 }); setSelection(null); setPastePreview(null); setMovePreview(null); setExportBaseName(file.name.replace(/\.bmask$/i, '') || `binary-mask-${payload.width}x${payload.height}`); resetHistory(); bumpDocument(false); setDocumentDirty(false); setAutoFitRequest((value) => value + 1); setToast('已打开 .bmask 图层工程。');
    } catch (error) { setToast(error instanceof Error ? error.message : '工程文件无法打开。'); }
  };
  const createNewCanvas = () => {
    if (!validateNumericInputs(newCanvasFieldsRef.current)) return;
    const nextWidth = Math.round(newWidth); const nextHeight = Math.round(newHeight); const nextDpi = Math.round(newDpi);
    if (nextWidth < 1 || nextHeight < 1 || nextWidth > MAX_DIMENSION || nextHeight > MAX_DIMENSION) { setToast(`宽度和高度必须在 1～${MAX_DIMENSION} 之间。`); return; }
    if (nextDpi < 1 || nextDpi > 2400) { setToast('DPI 必须在 1～2400 之间。'); return; }
    if (dirtyRef.current && !window.confirm('当前工程有未保存修改。确定新建画布并放弃这些修改吗？')) return;
    const layer = createLayer(nextWidth, nextHeight, '图层 1'); layersRef.current = [layer]; setWidth(nextWidth); setHeight(nextHeight); setDpi(nextDpi); setActiveLayerId(layer.id); setSelectedLayerIds([layer.id]); setCenterX(nextWidth / 2); setCenterY(nextHeight / 2); setCursor({ x: 0, y: 0 }); setSelection(null); setBinaryClipboard(null); setPastePreview(null); setMovePreview(null); setExportBaseName(`binary-mask-${nextWidth}x${nextHeight}`); resetHistory(); bumpDocument(false); setDocumentDirty(false); setNewCanvasOpen(false); setAutoFitRequest((value) => value + 1); setToast(`已创建 ${nextWidth} × ${nextHeight}、${nextDpi} DPI 画布，参数已锁定。`);
  };
  const exportPng = () => void withProcessing('正在导出 PNG', async () => { try { downloadBlob(await encodeOneBitPng(composite, width, height, dpi), `${safeExportBaseName}.png`); setToast('已导出严格的 1 位二值 PNG。'); } catch { setToast('当前浏览器不支持 1 位 PNG 编码。'); } });
  const exportMatrix = (format: 'csv' | 'txt') => void withProcessing(`正在导出 ${format.toUpperCase()}`, async () => { const separator = format === 'csv' ? ',' : ' '; downloadBlob(new Blob([binaryToText(composite, width, height, separator)], { type: 'text/plain;charset=utf-8' }), `${safeExportBaseName}.${format}`); setToast(`已导出 ${format.toUpperCase()} 二值矩阵。`); });
  const changeUnit = (nextUnit: SizeUnit) => { if (nextUnit === sizeUnit) return; const convert = (value: number) => fromPixels(toPixels(value, sizeUnit, dpi), nextUnit, dpi); setDimensionX(convert(dimensionX)); setDimensionY(convert(dimensionY)); setTriangleBase(convert(triangleBase)); setTriangleHeight(convert(triangleHeight)); setTriangleProjection(convert(triangleProjection)); setTextFontSize(convert(textFontSize)); setTextLetterSpacing(convert(textLetterSpacing)); setGratingWidth(convert(gratingWidth)); setGratingHeight(convert(gratingHeight)); setGratingPeriod(convert(gratingPeriod)); setGratingPhase(convert(gratingPhase)); setSizeUnit(nextUnit); };
  const toggleAspect = () => { if (!aspectLinked) setAspectRatio(dimensionX > 0 ? dimensionY / dimensionX : 1); setAspectLinked((value) => !value); };
  const updateDimensionX = (value: number) => { const next = Math.max(0.01, value || 0.01); setDimensionX(next); if (aspectLinked) setDimensionY(Math.max(0.01, next * aspectRatio)); };
  const updateDimensionY = (value: number) => { const next = Math.max(0.01, value || 0.01); setDimensionY(next); if (aspectLinked) setDimensionX(Math.max(0.01, next / (aspectRatio || 1))); };
  const toggleGratingAspect = () => { if (!gratingAspectLinked) setGratingAspectRatio(gratingWidth > 0 ? gratingHeight / gratingWidth : 1); setGratingAspectLinked((value) => !value); };
  const updateGratingWidth = (value: number) => { const next = Math.max(0.01, value || 0.01); setGratingWidth(next); if (gratingAspectLinked) setGratingHeight(Math.max(0.01, next * gratingAspectRatio)); };
  const updateGratingHeight = (value: number) => { const next = Math.max(0.01, value || 0.01); setGratingHeight(next); if (gratingAspectLinked) setGratingWidth(Math.max(0.01, next / (gratingAspectRatio || 1))); };
  const setZoomValue = (next: number) => { const normalized = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next))); setZoom(normalized); };
  const fitCanvas = () => setZoomValue(Math.floor(fitScale * 100));
  const actualSize = () => setZoomValue(100);
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => { event.preventDefault(); const frame = canvasFrameRef.current; if (!frame) return; const rect = frame.getBoundingClientRect(); pendingZoomAnchorRef.current = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), clientX: event.clientX, clientY: event.clientY }; setZoomValue(zoom + (event.deltaY < 0 ? 10 : -10)); };
  const refreshFromLogo = () => { if (!dirtyRef.current || window.confirm('当前工程有未保存修改。确定刷新网页并放弃这些修改吗？')) window.location.reload(); };
  const requestOpenProject = () => { if (!dirtyRef.current || window.confirm('当前工程有未保存修改。确定打开其他工程并放弃这些修改吗？')) projectInputRef.current?.click(); };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === 'Space' && !target?.matches('input, textarea, select, [contenteditable="true"]')) { event.preventDefault(); spacePressedRef.current = true; setSpacePressed(true); return; }
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (helpOpen || aboutOpen || matrixOpen || newCanvasOpen) {
        if (event.key === 'Escape') { setHelpOpen(false); setAboutOpen(false); setMatrixOpen(false); setNewCanvasOpen(false); }
        return;
      }
      const command = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
      if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (command && key === 'y') { event.preventDefault(); redo(); return; }
      if (command && key === 's') { event.preventDefault(); saveProject(); return; }
      if (command && key === 'o') { event.preventDefault(); requestOpenProject(); return; }
      if (command && key === 'a') { event.preventDefault(); selectAll(); return; }
      if (command && key === 'd') { event.preventDefault(); deselect(); return; }
      if (command && key === 'c') { event.preventDefault(); copySelection(); return; }
      if (command && key === 'v') { event.preventDefault(); beginPaste(); return; }
      if (command && key === '0') { event.preventDefault(); fitCanvas(); return; }
      if (command && key === '1') { event.preventDefault(); actualSize(); return; }
      if (pastePreview || movePreview) {
        if (event.key === 'Escape') { event.preventDefault(); setPastePreview(null); setMovePreview(null); return; }
        if (event.key === 'Enter') { event.preventDefault(); if (pastePreview) confirmPaste(); else confirmMove(); return; }
        if (event.key.startsWith('Arrow')) {
          event.preventDefault(); const step = event.shiftKey ? 10 : 1;
          if (pastePreview) setPastePreview((preview) => { if (!preview) return null; if (event.key === 'ArrowLeft') return { ...preview, x: preview.x - step }; if (event.key === 'ArrowRight') return { ...preview, x: preview.x + step }; if (event.key === 'ArrowUp') return { ...preview, y: preview.y - step }; return { ...preview, y: preview.y + step }; });
          else setMovePreview((preview) => { if (!preview) return null; if (event.key === 'ArrowLeft') return { ...preview, x: preview.x - step }; if (event.key === 'ArrowRight') return { ...preview, x: preview.x + step }; if (event.key === 'ArrowUp') return { ...preview, y: preview.y - step }; return { ...preview, y: preview.y + step }; });
          return;
        }
      }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelection(); return; }
      if (key === 'b') { activateTool('draw'); return; }
      if (key === 'e') { activateTool('erase'); return; }
      if (key === 'm') { activateTool('select'); return; }
      if (key === 'v') { beginMove(); return; }
      if (event.key === '[') { setBrushSize((value) => Math.max(1, value - 1)); return; }
      if (event.key === ']') { setBrushSize((value) => Math.min(128, value + 1)); }
    };
    const handleKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') { spacePressedRef.current = false; setSpacePressed(false); } };
    const handleBlur = () => { spacePressedRef.current = false; setSpacePressed(false); };
    window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp); window.addEventListener('blur', handleBlur);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); window.removeEventListener('blur', handleBlur); };
  });

  const matrixGridColumns = Array.from({ length: Math.min(MATRIX_COLUMNS, matrixRegion.x + matrixRegion.width - matrixStartX) }, (_, index) => matrixStartX + index);
  const matrixGridRows = Array.from({ length: Math.min(MATRIX_ROWS, matrixRegion.y + matrixRegion.height - matrixStartY) }, (_, index) => matrixStartY + index);
  const selectionLabel = selection ? `X ${selection.x}–${selection.x + selection.width - 1} · Y ${selection.y}–${selection.y + selection.height - 1} · ${selection.width}×${selection.height} px` : '';
  const layerList = layersRef.current;
  const activeLayerIndex = layerList.findIndex((layer) => layer.id === activeLayerId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" aria-label={dirty ? '刷新网页，当前有未保存修改' : '刷新网页'} onClick={refreshFromLogo}><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span><strong>二值掩膜工坊{dirty ? <i className="dirty-dot" title="有未保存修改" /> : null}</strong><small>BINARY MASK STUDIO</small></span></button>
        <div className="topbar-actions"><button type="button" aria-label="帮助" title="帮助" onClick={() => void openInfoWindow('help')}>?</button><button type="button" aria-label="应用信息" title="应用信息" onClick={() => void openInfoWindow('about')}>!</button></div>
      </header>
      <section className="workspace">
        <aside className="panel settings-panel">
          <SectionHeading number="01" title="画布参数" subtitle="CANVAS" />
          <div className="canvas-parameter-stack">
            <div className="field-grid two-columns compact-fields"><label>宽度<div className="input-shell"><input type="number" value={width} disabled /><FieldSuffix>px</FieldSuffix></div></label><label>高度<div className="input-shell"><input type="number" value={height} disabled /><FieldSuffix>px</FieldSuffix></div></label></div>
            <div className="dpi-row"><label>DPI<div className="input-shell"><input type="number" value={dpi} disabled /></div></label><button type="button" onClick={() => { setNewWidth(width); setNewHeight(height); setNewDpi(dpi); setNewCanvasOpen(true); }}>新建画布</button></div>
            <div className="physical-size"><span>物理尺寸</span><strong>{physicalWidth} × {physicalHeight} mm</strong></div>
          </div>
          <div className="section-rule" />
          <div ref={shapeFieldsRef} className="shape-section" onFocusCapture={() => setTool('shape')}>
          <SectionHeading number="02" title="精确图形" subtitle="PARAMETRIC SHAPE" />
          <label>图形类型<select value={shape} onChange={(event) => setShape(event.target.value as ParametricKind)}><option value="circle">圆</option><option value="triangle">三角形</option><option value="rectangle">矩形</option><option value="text">文本</option><option value="grating">光栅</option></select></label>
          <div className="field-grid two-columns"><label>中心 X<NumericInput className="number-input" step="0.5" value={centerX} onValueChange={(value) => setCenterX(value)} /></label><label>中心 Y<NumericInput className="number-input" step="0.5" value={centerY} onValueChange={(value) => setCenterY(value)} /></label></div>
          {shape === 'text' ? <>
            <label>文本内容<textarea className="text-content-input" rows={3} value={textContent} onChange={(event) => setTextContent(event.target.value)} spellCheck={false} placeholder="输入单行或多行文本" /></label>
            <div className="field-grid two-columns"><label>字号<NumericInput className="number-input" min="0.5" step="0.5" value={Number(textFontSize.toFixed(4))} onValueChange={(value) => setTextFontSize(Math.max(0.5, value || 0.5))} /></label><label>字间距<NumericInput className="number-input" step="0.5" value={Number(textLetterSpacing.toFixed(4))} onValueChange={(value) => setTextLetterSpacing(value || 0)} /></label></div>
            <div className="field-grid two-columns"><label>字体<select value={textFont} onChange={(event) => setTextFont(event.target.value as TextFont)}><option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label><label>字重<select value={textWeight} onChange={(event) => setTextWeight(event.target.value as TextWeight)}><option value="400">常规</option><option value="700">粗体</option></select></label></div>
            <div className="field-grid two-columns"><label>行距倍数<NumericInput className="number-input" min="0.1" step="0.1" value={textLineHeight} onValueChange={(value) => setTextLineHeight(Math.max(0.1, value || 0.1))} /></label><label>多行对齐<select value={textAlignment} onChange={(event) => setTextAlignment(event.target.value as TextAlignment)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></div>
          </> : shape === 'grating' ? <>
            <div className="linked-dimensions">
              <label>区域宽度<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingWidth.toFixed(4))} onValueChange={(value) => updateGratingWidth(value)} /></label>
              <button className={gratingAspectLinked ? 'link-button active' : 'link-button'} type="button" aria-label={gratingAspectLinked ? '解除区域比例锁定' : '锁定当前区域比例'} aria-pressed={gratingAspectLinked} onClick={toggleGratingAspect}><LinkIcon /></button>
              <label>区域高度<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingHeight.toFixed(4))} onValueChange={(value) => updateGratingHeight(value)} /></label>
            </div>
            <div className="field-grid two-columns"><label>周期<NumericInput className="number-input" min="0.01" step="0.5" value={Number(gratingPeriod.toFixed(4))} onValueChange={(value) => setGratingPeriod(Math.max(0.01, value || 0.01))} /></label><label>栅线占空比<div className="input-shell"><NumericInput className="number-input" min="0" max="100" step="0.1" value={gratingDuty} onValueChange={(value) => setGratingDuty(Math.max(0, Math.min(100, value || 0)))} /><FieldSuffix>%</FieldSuffix></div></label></div>
            <label>相位偏移<NumericInput className="number-input" step="0.5" value={Number(gratingPhase.toFixed(4))} onValueChange={(value) => setGratingPhase(value || 0)} /></label>
          </> : shape !== 'triangle' ? <div className="linked-dimensions">
            <label>{shape === 'circle' ? '直径 X' : '宽度 X'}<NumericInput className="number-input" min="0.01" step="0.5" value={Number(dimensionX.toFixed(4))} onValueChange={(value) => updateDimensionX(value)} /></label>
            <button className={aspectLinked ? 'link-button active' : 'link-button'} type="button" aria-label={aspectLinked ? '解除比例锁定' : '锁定当前比例'} aria-pressed={aspectLinked} onClick={toggleAspect}><LinkIcon /></button>
            <label>{shape === 'circle' ? '直径 Y' : '高度 Y'}<NumericInput className="number-input" min="0.01" step="0.5" value={Number(dimensionY.toFixed(4))} onValueChange={(value) => updateDimensionY(value)} /></label>
          </div> : <>
            <label>底边长度<NumericInput className="number-input" min="0.01" step="0.5" value={Number(triangleBase.toFixed(4))} onValueChange={(value) => setTriangleBase(Math.max(0.01, value || 0.01))} /></label>
            <div className="field-grid two-columns"><label>底边对应的高<NumericInput className="number-input" min="0.01" step="0.5" disabled={equilateral} value={Number(resolvedTriangleHeight.toFixed(4))} onValueChange={(value) => setTriangleHeight(Math.max(0.01, value || 0.01))} /></label><label>顶点投影距离<NumericInput className="number-input" step="0.5" disabled={equilateral} value={Number(resolvedTriangleProjection.toFixed(4))} onValueChange={(value) => setTriangleProjection(value || 0)} /></label></div>
            <label className="checkbox-row"><input type="checkbox" checked={equilateral} onChange={(event) => { const checked = event.target.checked; if (!checked) { setTriangleHeight((triangleBase * Math.sqrt(3)) / 2); setTriangleProjection(triangleBase / 2); } setEquilateral(checked); }} /><span>等边三角形</span></label>
          </>}
          <div className="shape-unit-row"><label>单位<select value={sizeUnit} onChange={(event) => changeUnit(event.target.value as SizeUnit)}><option value="px">px</option><option value="mm">mm</option></select></label><label>旋转<div className="input-shell"><NumericInput className="number-input" step="1" value={rotation} onValueChange={(value) => setRotation(value || 0)} /><FieldSuffix>°</FieldSuffix></div></label></div>
          {shape === 'grating' ? <><label>写入模式<select value={gratingWriteMode} onChange={(event) => setGratingWriteMode(event.target.value as GratingWriteMode)}><option value="cover">完整覆盖</option><option value="lines">仅写栅线</option></select></label>{gratingWriteMode === 'cover' ? <label>极性<select value={gratingPolarity} onChange={(event) => setGratingPolarity(event.target.value as GratingPolarity)}><option value="line1">栅线 1 · 间隔 0</option><option value="line0">栅线 0 · 间隔 1</option></select></label> : <label>栅线操作<select value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}><option value="set1">写入 1</option><option value="set0">写入 0</option><option value="xor">反转 XOR</option></select></label>}</> : <label>布尔操作<select value={operation} onChange={(event) => setOperation(event.target.value as BooleanOperation)}><option value="set1">写入 1</option><option value="set0">写入 0</option><option value="xor">反转 XOR</option></select></label>}
          <div className={`shape-readout ${!hasParametricContent || !clippedRange.hasIntersection ? 'error' : partiallyOutside || gratingAliased ? 'warning' : ''}`}><span>{shape === 'text' ? '文字像素范围' : shape === 'grating' ? '光栅像素范围' : '画布内像素范围'}</span><strong>{displayBounds}</strong><small>{parametricHint}</small></div>
          <button className="primary-button" type="button" disabled={!hasParametricContent || !clippedRange.hasIntersection || activeLayer.locked || Boolean(processing)} onClick={applyShape}>应用{parametricLabel}到当前图层 <span>↗</span></button>
          </div>
        </aside>

        <section className="canvas-column">
          <div className={`toolstrip ${tool === 'draw' || tool === 'erase' ? 'brush-open' : ''}`} aria-label="绘图工具">
            <div className="tool-group">
              <div className="tool-popover-anchor"><button className={tool === 'draw' ? 'active' : ''} type="button" onClick={() => activateTool('draw')}><span>✎</span>自由绘制</button>{tool === 'draw' && <div className="brush-popover"><div className="range-wrap"><input aria-label="画笔大小" type="range" min="1" max="128" value={brushSize} onPointerDown={() => setBrushDragging(true)} onPointerUp={() => setBrushDragging(false)} onPointerCancel={() => setBrushDragging(false)} onChange={(event) => setBrushSize(Number(event.target.value))} />{brushDragging && <b style={{ left: `${((brushSize - 1) / 127) * 100}%` }}>{brushSize}px</b>}</div><div className="paint-toggle" role="group" aria-label="绘制值"><button className={paintValue === 0 ? 'selected black' : 'black'} type="button" aria-label="绘制黑色 0" title="黑色 0" onClick={() => setPaintValue(0)} /><button className={paintValue === 1 ? 'selected white' : 'white'} type="button" aria-label="绘制白色 1" title="白色 1" onClick={() => setPaintValue(1)} /></div></div>}</div>
              <div className="tool-popover-anchor"><button className={tool === 'erase' ? 'active' : ''} type="button" onClick={() => activateTool('erase')}><span>⌫</span>擦除</button>{tool === 'erase' && <div className="brush-popover erase-popover"><div className="range-wrap"><input aria-label="橡皮擦大小" type="range" min="1" max="128" value={brushSize} onPointerDown={() => setBrushDragging(true)} onPointerUp={() => setBrushDragging(false)} onPointerCancel={() => setBrushDragging(false)} onChange={(event) => setBrushSize(Number(event.target.value))} />{brushDragging && <b style={{ left: `${((brushSize - 1) / 127) * 100}%` }}>{brushSize}px</b>}</div></div>}</div>
              <button className={tool === 'select' ? 'active' : ''} type="button" onClick={() => activateTool('select')}><span>▧</span>选区</button>
              <button className={tool === 'move' ? 'active' : ''} type="button" disabled={!selection || activeLayer.locked} onClick={beginMove}><span>✥</span>移动</button>
            </div>
            <div className="tool-divider" /><div className="tool-group"><button type="button" disabled={!selection} onClick={copySelection}>复制</button><button type="button" disabled={!binaryClipboard} onClick={beginPaste}>粘贴</button></div>
            <div className="tool-divider" /><div className="tool-group"><button type="button" disabled={!undoRef.current.length} onClick={undo}>撤销</button><button type="button" disabled={!redoRef.current.length} onClick={redo}>前进</button><button type="button" onClick={invertActiveLayer}>反转</button><button type="button" onClick={clearActiveLayer}>清空</button></div>
            <div className="tool-divider" /><div className="tool-group">
              <input ref={fileInputRef} className="visually-hidden" type="file" accept=".png,.txt,.csv,text/plain,image/png" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.currentTarget.value = ''; }} />
              <input ref={projectInputRef} className="visually-hidden" type="file" accept=".bmask,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.currentTarget.value = ''; }} />
              <button type="button" disabled={Boolean(processing)} onClick={() => fileInputRef.current?.click()}>导入</button><button type="button" disabled={Boolean(processing)} onClick={openMatrixEditor}>矩阵</button><button type="button" disabled={Boolean(processing)} onClick={requestOpenProject}>打开工程</button><button type="button" disabled={Boolean(processing)} onClick={saveProject}>保存工程</button>
            </div>
            {selectionLabel && <span className="selection-chip">{selectionLabel}<button type="button" aria-label="取消选区" title="取消选区" onClick={deselect}>×</button></span>}
            {processing && <span className="processing-chip"><i />{processing}</span>}
            <div className="zoom-tools"><button type="button" aria-label="适合窗口" title="适合窗口 Ctrl+0" onClick={fitCanvas}><FitIcon /></button><label className="zoom-control" aria-label="画布缩放比例"><NumericInput value={zoom} suffix="%" min={MIN_ZOOM} max={MAX_ZOOM} onValueChange={setZoomValue} /></label></div>
          </div>
          <div ref={stageRef} className={`stage ${spacePressed ? 'pan-ready' : ''} ${panRef.current ? 'panning' : ''}`} onWheel={handleWheel}><div className="stage-inner" style={{ minWidth: `${displayWidth + 112}px`, minHeight: `${displayHeight + 104}px` }}><div className="canvas-shell" style={{ width: `${displayWidth}px`, height: `${displayHeight}px`, '--grid-size': `${Math.max(8, 24 * (zoom / 100))}px` } as CSSProperties}>
            <div className="ruler ruler-x"><span /><span>{width / 2}</span><span>{width}</span></div><div className="ruler ruler-y"><span /><span>{height / 2}</span><span>{height}</span></div>
            <div ref={canvasFrameRef} className="canvas-frame"><canvas ref={canvasRef} aria-label="二值图像画布" /><canvas ref={overlayRef} className={`drawing-layer tool-${tool}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={stopPointerAction} onPointerCancel={stopPointerAction} onDoubleClick={(event) => { if (event.button !== 0) return; if (pastePreview) { event.preventDefault(); confirmPaste(); } else if (movePreview) { event.preventDefault(); confirmMove(); } }} aria-label="绘图交互层" /><span className="axis axis-x" /><span className="axis axis-y" /><span className="origin-dot" /><span className="origin-label">(0, 0)</span></div>
          </div></div></div>
        </section>

        <aside className="right-sidebar">
          <section className="panel layer-panel"><SectionHeading number="03" title="图层操作" subtitle="LAYERS" />
            <div className="layer-actions primary-actions"><div className="layer-create-control" ref={layerCreateRef}><button type="button" aria-haspopup="menu" aria-expanded={layerCreateMenuOpen} onClick={() => setLayerCreateMenuOpen((open) => !open)}>新建</button>{layerCreateMenuOpen && <div className="layer-create-menu" role="menu" aria-label="新建图层类型"><button type="button" role="menuitem" onClick={() => addLayer(TRANSPARENT)}><i className="layer-fill-swatch transparent" aria-hidden="true" /><span>透明图层</span></button><button type="button" role="menuitem" onClick={() => addLayer(OPAQUE_ZERO)}><i className="layer-fill-swatch zero" aria-hidden="true" /><span>黑色 0 图层</span></button><button type="button" role="menuitem" onClick={() => addLayer(OPAQUE_ONE)}><i className="layer-fill-swatch one" aria-hidden="true" /><span>白色 1 图层</span></button></div>}</div><button type="button" onClick={duplicateSelectedLayers}>复制图层</button><button type="button" onClick={cutSelectedLayers}>剪切图层</button><button type="button" disabled={!layerClipboardRef.current.length} onClick={pasteLayers}>粘贴图层</button></div>
            <div className="layer-actions secondary-actions"><button type="button" disabled={selectedLayerIds.length < 2} onClick={mergeSelectedLayers}>合并选中</button><button type="button" disabled={selectedLayerIds.length !== 1 || activeLayerIndex <= 0 || activeLayer.locked} onClick={() => moveActiveLayer(-1)}>上移</button><button type="button" disabled={selectedLayerIds.length !== 1 || activeLayerIndex >= layerList.length - 1 || activeLayer.locked} onClick={() => moveActiveLayer(1)}>下移</button><button className="danger-text" type="button" onClick={deleteSelectedLayers}>删除</button></div>
            <div className="layer-list" aria-label="图层列表">{layerList.map((layer) => {
              const selected = selectedSet.has(layer.id); const active = layer.id === activeLayerId;
              return <div key={layer.id} className={`layer-row ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${layer.locked ? 'locked' : ''}`} draggable={!layer.locked} onDragStart={() => setDragLayerId(layer.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropLayer(layer.id)} onClick={(event) => selectLayer(event, layer.id)} onDoubleClick={() => renameLayer(layer.id)}>
                <button type="button" className="icon-button" aria-label={layer.visible ? '隐藏图层' : '显示图层'} title={layer.visible ? '隐藏图层' : '显示图层'} onClick={(event) => { event.stopPropagation(); toggleLayerVisibility(layer.id); }}><EyeIcon open={layer.visible} /></button><LayerThumbnail layer={layer} width={width} height={height} version={docVersion} /><span className="layer-name"><strong>{layer.name}</strong><small>{layer.visible ? '可见' : '隐藏'} · {layer.locked ? '已锁定' : '可编辑'}</small></span><button type="button" className="icon-button lock-button" aria-label={layer.locked ? '解锁图层' : '锁定图层'} title={layer.locked ? '解锁图层' : '锁定图层'} onClick={(event) => { event.stopPropagation(); toggleLayerLock(layer.id); }}><LockIcon locked={layer.locked} /></button><span className="drag-handle" aria-hidden="true">⋮⋮</span>
              </div>;
            })}</div>
            <button className="clear-all-button" type="button" onClick={clearAllLayers}>清空全部图层</button>
          </section>
          <section className="panel inspector-panel"><SectionHeading number="04" title="矩阵检查" subtitle="INSPECTOR" />
            <div className="coordinate-card"><small>当前像素 · 左上角坐标</small><div><span>X</span><strong>{cursor.x}</strong><span>Y</span><strong>{cursor.y}</strong></div><p>当前像素值 <b>{currentValue}</b></p></div>
            <div className="metric-list"><div><span>白色像素</span><strong>{whitePixels.toLocaleString('zh-CN')} ({((whitePixels / (width * height)) * 100).toFixed(4)}%)</strong></div><div><span>像素总数</span><strong>{(width * height).toLocaleString('zh-CN')}</strong></div></div>
            <label className="export-name">导出文件名<input value={exportBaseName} onChange={(event) => setExportBaseName(event.target.value)} onBlur={() => setExportBaseName(safeExportBaseName)} /></label>
            <div className="download-row"><button type="button" disabled={Boolean(processing)} onClick={exportPng}>导出 PNG</button><button type="button" disabled={Boolean(processing)} onClick={() => exportMatrix('csv')}>导出 CSV</button><button type="button" disabled={Boolean(processing)} onClick={() => exportMatrix('txt')}>导出 TXT</button></div>
          </section>
        </aside>
      </section>

      {newCanvasOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewCanvasOpen(false); }}><section ref={newCanvasFieldsRef} className="dialog-card new-canvas-dialog" role="dialog" aria-modal="true" aria-labelledby="new-canvas-title">
        <div className="modal-header"><div><small>NEW BINARY DOCUMENT</small><h2 id="new-canvas-title">新建画布</h2></div><button type="button" aria-label="关闭" onClick={() => setNewCanvasOpen(false)}>×</button></div><p>创建后，宽度、高度和 DPI 将锁定。每个图层都使用相同的画布尺寸。</p>
        <div className="field-grid two-columns"><label>宽度<div className="input-shell"><NumericInput className="number-input" min="1" max={MAX_DIMENSION} value={newWidth} onValueChange={(value) => setNewWidth(value)} /><FieldSuffix>px</FieldSuffix></div></label><label>高度<div className="input-shell"><NumericInput className="number-input" min="1" max={MAX_DIMENSION} value={newHeight} onValueChange={(value) => setNewHeight(value)} /><FieldSuffix>px</FieldSuffix></div></label></div>
        <label>DPI<NumericInput className="number-input" min="1" max="2400" value={newDpi} onValueChange={(value) => setNewDpi(value)} /></label><div className="physical-size"><span>物理尺寸</span><strong>{newDpi > 0 ? ((newWidth / newDpi) * 25.4).toFixed(2) : '—'} × {newDpi > 0 ? ((newHeight / newDpi) * 25.4).toFixed(2) : '—'} mm</strong></div>
        <div className="modal-footer"><button type="button" onClick={() => setNewCanvasOpen(false)}>取消</button><button className="modal-primary" type="button" onClick={createNewCanvas}>创建并锁定参数</button></div>
      </section></div>}

      {matrixOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMatrixOpen(false); }}><section ref={matrixFieldsRef} className="dialog-card matrix-modal" role="dialog" aria-modal="true" aria-labelledby="matrix-title">
        <div className="modal-header"><div><small>CURRENT LAYER MATRIX</small><h2 id="matrix-title">编辑当前图层 · {activeLayer.name}</h2></div><button type="button" aria-label="关闭" onClick={() => setMatrixOpen(false)}>×</button></div>
        <div className="matrix-legend"><span><i className="transparent-swatch">·</i>透明</span><span><i className="zero-swatch">0</i>黑色</span><span><i className="one-swatch">1</i>白色</span><b>{matrixRegion.width} × {matrixRegion.height}</b></div>
        <div className="matrix-scope" role="group" aria-label="矩阵编辑范围"><button className={matrixScope === 'layer' ? 'active' : ''} type="button" onClick={() => changeMatrixScope('layer')}>整个图层</button><button className={matrixScope === 'selection' ? 'active' : ''} type="button" disabled={!selection} onClick={() => changeMatrixScope('selection')}>当前选区</button><span>{matrixScope === 'selection' ? `X ${matrixRegion.x}～${matrixRegion.x + matrixRegion.width - 1} · Y ${matrixRegion.y}～${matrixRegion.y + matrixRegion.height - 1}` : '编辑完整图层矩阵'}</span></div>
        <div className="modal-tabs"><button className={matrixView === 'cells' ? 'active' : ''} type="button" onClick={() => setMatrixView('cells')}>单元格编辑</button><button className={matrixView === 'text' ? 'active' : ''} type="button" onClick={() => setMatrixView('text')}>文本输入</button></div>
        {matrixView === 'cells' ? <div className="cell-editor">
          <div className="matrix-navigation"><label>起点 X<NumericInput className="number-input" min={matrixRegion.x} max={matrixRegion.x + matrixRegion.width - 1} value={matrixStartX} onValueChange={(value) => setMatrixStartX(Math.max(matrixRegion.x, Math.min(matrixRegion.x + matrixRegion.width - 1, value || matrixRegion.x)))} /></label><label>起点 Y<NumericInput className="number-input" min={matrixRegion.y} max={matrixRegion.y + matrixRegion.height - 1} value={matrixStartY} onValueChange={(value) => setMatrixStartY(Math.max(matrixRegion.y, Math.min(matrixRegion.y + matrixRegion.height - 1, value || matrixRegion.y)))} /></label><button type="button" onClick={() => setMatrixStartX(Math.max(matrixRegion.x, matrixStartX - MATRIX_COLUMNS))}>←</button><button type="button" onClick={() => setMatrixStartX(Math.min(matrixRegion.x + matrixRegion.width - 1, matrixStartX + MATRIX_COLUMNS))}>→</button><button type="button" onClick={() => setMatrixStartY(Math.max(matrixRegion.y, matrixStartY - MATRIX_ROWS))}>↑</button><button type="button" onClick={() => setMatrixStartY(Math.min(matrixRegion.y + matrixRegion.height - 1, matrixStartY + MATRIX_ROWS))}>↓</button></div>
          <div className="matrix-grid-wrap"><div className="matrix-grid" style={{ gridTemplateColumns: `46px repeat(${matrixGridColumns.length}, 34px)` }} data-version={matrixDraftVersion}><span className="corner-cell">Y / X</span>{matrixGridColumns.map((x) => <span className="axis-cell" key={`x-${x}`}>{x}</span>)}{matrixGridRows.flatMap((y) => [<span className="axis-cell row-axis" key={`y-${y}`}>{y}</span>, ...matrixGridColumns.map((x) => { const value = matrixDraftRef.current?.[y * width + x] ?? TRANSPARENT; return <button type="button" key={`${x}-${y}`} className={`matrix-cell state-${value}`} aria-label={`X ${x}，Y ${y}，${value === OPAQUE_ONE ? '1 白色' : value === OPAQUE_ZERO ? '0 黑色' : '透明'}`} onClick={() => setMatrixCell(x, y)} onKeyDown={(event) => { if (event.key === '0') setMatrixCell(x, y, OPAQUE_ZERO); else if (event.key === '1') setMatrixCell(x, y, OPAQUE_ONE); else if (event.key === 'Delete' || event.key === 'Backspace') setMatrixCell(x, y, TRANSPARENT); }}>{value === OPAQUE_ONE ? '1' : value === OPAQUE_ZERO ? '0' : '·'}</button>; })])}</div></div>
          <p>单击按“透明 → 0 → 1”循环；键盘输入 0/1，Delete 或 Backspace 恢复透明。</p>
        </div> : <div className="text-matrix-editor"><p>第一行固定对应编辑范围顶部。输入尺寸必须与{matrixScope === 'selection' ? '当前选区' : '完整图层'}一致；支持空格、逗号、换行和 MATLAB 分号。</p><button type="button" onClick={loadMatrixText}>载入{matrixScope === 'selection' ? '当前选区' : '当前图层'}文本</button><textarea value={matrixText} onChange={(event) => setMatrixText(event.target.value)} spellCheck={false} placeholder={'· · · · ·\n· 0 1 0 ·\n· 1 1 1 ·\n· · · · ·'} /></div>}
        <div className="modal-footer"><span>所有修改将在确认时作为一个撤销步骤。</span><button type="button" onClick={() => setMatrixOpen(false)}>取消</button><button className="modal-primary" type="button" disabled={activeLayer.locked} onClick={applyMatrixEditor}>应用到当前图层</button></div>
      </section></div>}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} quote={quote} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} quote={quote} />}
      {pastePreview && <div className="paste-hint">鼠标定位左上角 · Enter / 双击确认 · Esc 取消 · 方向键微调</div>}
      {movePreview && <div className="move-hint"><strong>ΔX {movePreview.x - movePreview.source.x >= 0 ? '+' : ''}{movePreview.x - movePreview.source.x} · ΔY {movePreview.y - movePreview.source.y >= 0 ? '+' : ''}{movePreview.y - movePreview.source.y}</strong><span>X {movePreview.x} · Y {movePreview.y}</span><small>鼠标定位左上角 · Enter / 双击确认 · Esc 取消 · 方向键微调</small></div>}
      {toast && <div className="toast" role="status"><span />{toast}</div>}
      <span className="history-sentinel" data-history-version={historyVersion} data-layer-clipboard-version={layerClipboardVersion} />
    </main>
  );
}
