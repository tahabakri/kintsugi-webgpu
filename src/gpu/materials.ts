import type { MaterialName } from '../config';
import { MATERIALS } from '../config';

/** Shader parameters for one ceramic preset. Colours are linear RGB. */
export interface CeramicPreset {
  label: string;
  /** Glaze colour and roughness. */
  glaze: [number, number, number, number];
  /** Brushwork / pooling / flash colour and its strength. */
  secondary: [number, number, number, number];
  /** Exposed ceramic body colour and roughness. */
  body: [number, number, number, number];
  crackle: number;
  speckle: number;
  grain: number;
  /** sRGB hex colours for the UI swatch: glaze, accent, body. */
  swatch: [string, string, string];
}

export const PRESETS: Record<MaterialName, CeramicPreset> = {
  porcelain: {
    label: 'Porcelain',
    glaze: [0.885, 0.862, 0.798, 0.085],
    secondary: [0.092, 0.175, 0.47, 1],
    body: [0.74, 0.68, 0.585, 0.78],
    crackle: 0.36,
    speckle: 0,
    grain: 0.25,
    swatch: ['#ece8dc', '#3c5e97', '#e6dfd0'],
  },
  celadon: {
    label: 'Celadon',
    glaze: [0.4, 0.52, 0.37, 0.16],
    secondary: [0.2, 0.33, 0.235, 1],
    body: [0.6, 0.58, 0.52, 0.76],
    crackle: 0.055,
    speckle: 0,
    grain: 0.2,
    swatch: ['#a8bd9f', '#7d9a80', '#cbc6ba'],
  },
  raku: {
    label: 'Raku',
    glaze: [0.024, 0.023, 0.022, 0.3],
    secondary: [0.42, 0.165, 0.055, 1],
    body: [0.35, 0.32, 0.29, 0.82],
    crackle: 0,
    speckle: 0.6,
    grain: 0.5,
    swatch: ['#2d2b29', '#a8643a', '#9d968c'],
  },
  terracotta: {
    label: 'Terracotta',
    glaze: [0.5, 0.195, 0.085, 0.46],
    secondary: [0.24, 0.085, 0.04, 1],
    body: [0.31, 0.12, 0.06, 0.86],
    crackle: 0,
    speckle: 0.7,
    grain: 0.8,
    swatch: ['#bd7a55', '#8c4e30', '#96573a'],
  },
};

export const presetIndex = (name: MaterialName): number => MATERIALS.indexOf(name);
