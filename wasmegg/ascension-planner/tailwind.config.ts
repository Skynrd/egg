import type { Config } from 'tailwindcss';
import colors from 'tailwindcss/colors';
import forms from '@tailwindcss/forms';
import plugin from 'tailwindcss/plugin';

/*
 * Dark mode is a palette swap rather than per-class `dark:` variants: every Tailwind color below
 * resolves through a CSS variable, and `html.dark` redefines those variables with a remapped
 * palette (light surfaces become dark, dark text becomes light, accent tints become deep washes).
 * That way the ~90 existing components go dark without touching their class lists.
 */

type Scale = Record<string, string>;
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone'];
const ACCENTS = [
  'red', 'orange', 'amber', 'lime', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'fuchsia', 'pink', 'rose',
];
// The app's aliases (see theme.extend.colors) share the variables of the scale they point at.
const ALIASES: Record<string, string> = { green: 'emerald', yellow: 'amber', purple: 'violet' };

// Dark card surface; `white` maps here so `bg-white` cards sit one step above the page background.
const DARK_SURFACE = colors.slate[800];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, weightA: number): string {
  const [ra, ga, ba] = hexToRgb(a);
  const [rb, gb, bb] = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x * weightA + y * (1 - weightA));
  return '#' + [ch(ra, rb), ch(ga, gb), ch(ba, bb)].map(v => v.toString(16).padStart(2, '0')).join('');
}
const channels = (hex: string) => hexToRgb(hex).join(' ');

// Neutrals mirror around the middle so "faint on white" stays "faint on dark".
function darkNeutral(s: Scale): Scale {
  return {
    50: mix(s[800], s[900], 0.4), 100: s[700], 200: s[600], 300: s[500], 400: mix(s[400], s[500], 0.6),
    500: s[400], 600: s[300], 700: s[200], 800: s[100], 900: s[50], 950: '#ffffff',
  };
}
// Accents: pale tints become muted washes over the dark surface, deep text shades become light,
// and the mid shades used for buttons with white text stay saturated enough to keep contrast.
function darkAccent(s: Scale): Scale {
  return {
    50: mix(s[950], DARK_SURFACE, 0.45), 100: mix(s[900], DARK_SURFACE, 0.6), 200: s[800], 300: s[700],
    400: s[400], 500: mix(s[400], s[500], 0.5), 600: s[500], 700: s[400], 800: s[300], 900: s[200], 950: s[100],
  };
}

const lightVars: Record<string, string> = { '--c-white': '255 255 255' };
const darkVars: Record<string, string> = { '--c-white': channels(DARK_SURFACE) };
const themedColors: Record<string, string | Scale> = {
  white: 'rgb(var(--c-white) / <alpha-value>)',
};
for (const name of [...NEUTRALS, ...ACCENTS]) {
  const light = (colors as unknown as Record<string, Scale>)[name];
  const dark = NEUTRALS.includes(name) ? darkNeutral(light) : darkAccent(light);
  const scale: Scale = {};
  for (const shade of SHADES) {
    lightVars[`--c-${name}-${shade}`] = channels(light[shade]);
    darkVars[`--c-${name}-${shade}`] = channels(dark[shade]);
    scale[shade] = `rgb(var(--c-${name}-${shade}) / <alpha-value>)`;
  }
  themedColors[name] = scale;
}
for (const [alias, target] of Object.entries(ALIASES)) themedColors[alias] = themedColors[target];

// Solid dark fills (tooltips, "active" pills, the nav bar) are already dark in light mode, so
// remapping them would turn them light under their white text. These elements re-establish the
// light palette for themselves and their children instead. Exact class tokens only, so a
// translucent modal backdrop (`bg-slate-900/60`) doesn't drag the whole dialog back to light mode.
const lightIslands = [
  ...NEUTRALS.flatMap(n => ['600', '700', '800', '900', '950'].map(s => `bg-${n}-${s}`)),
  ...ACCENTS.flatMap(n => ['800', '900', '950'].map(s => `bg-${n}-${s}`)),
  'bg-slate-900/90',
  'bg-slate-900/95',
].map(c => `html.dark .${c.replace('/', '\\/')}`);

const themePalette = plugin(({ addBase }) => {
  addBase({
    ':root': lightVars,
    [lightIslands.join(',\n')]: lightVars,
    'html.dark': { ...darkVars, colorScheme: 'dark' },
  });
});

export default {
  content: ['./index.html', './src/**/*.{vue,ts}', '../../ui/**/*.vue'],
  safelist: ['h-4', 'w-4', 'h-5', 'w-5', 'h-6', 'w-6'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ...themedColors,
        brand: {
          primary: 'var(--color-brand-primary)',
          secondary: 'var(--color-brand-secondary)',
          tertiary: 'var(--color-brand-tertiary)',
        }
      },
    },
  },
  plugins: [forms, themePalette],
} satisfies Config;
