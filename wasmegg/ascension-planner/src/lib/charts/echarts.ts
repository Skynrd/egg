/**
 * Central, tree-shaken echarts registration.
 *
 * Import `echarts` from here (never from the top-level `echarts` package) so every chart in this
 * app shares one registration call and one bundle-sized subset of components — pulling in
 * `echarts/core` + only the pieces below keeps the chart bundle to a fraction of the full
 * `echarts` package (which registers every chart type, including many this app never uses).
 */
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import type { LineSeriesOption } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  MarkLineComponent,
  DataZoomComponent,
} from 'echarts/components';
import type {
  GridComponentOption,
  TooltipComponentOption,
  LegendComponentOption,
  DataZoomComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComposeOption } from 'echarts/core';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  MarkLineComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export type ChartOption = ComposeOption<
  LineSeriesOption | GridComponentOption | TooltipComponentOption | LegendComponentOption | DataZoomComponentOption
>;

export { echarts };
export type { ECharts } from 'echarts/core';

/** Axis/grid/marker colors shared by the comparison charts, per theme. */
export function chartPalette(dark: boolean) {
  return dark
    ? { axis: '#64748b', grid: '#334155', name: '#cbd5e1', ink: '#f1f5f9', markerBorder: '#1e293b' }
    : { axis: '#c3c2b7', grid: '#e1e0d9', name: '#52514e', ink: '#0b0b0b', markerBorder: '#fff' };
}
