<template>
  <div>
    <div class="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-5 space-y-5">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-xs font-black text-slate-700 uppercase tracking-wider">Path Optimizer</h3>
        <div class="flex rounded-xl bg-white border border-slate-200 p-0.5">
          <button
            v-for="option in modeOptions"
            :key="option.value"
            type="button"
            class="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors"
            :class="settings.mode === option.value ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-indigo-600'"
            @click="settings.mode = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <p v-if="settings.mode === 'te'" class="text-[10px] font-bold text-slate-400 leading-relaxed">
        Finds the fastest sequence of ascension stops to the last number in Target TE(s), then replaces the
        field with that path and generates it.
      </p>
      <div v-else class="space-y-1.5">
        <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Deadline</label>
        <div class="flex gap-3">
          <input v-model="settings.deadlineDate" type="date" :class="inputClass" class="flex-grow" />
          <input v-model="settings.deadlineTime" type="time" :class="inputClass" class="w-32" />
        </div>
        <p class="text-[10px] font-bold text-slate-400 leading-relaxed px-1">
          Finds the path that reaches the most TE by this date ({{ timezone }}).
        </p>
      </div>

      <div class="flex justify-end">
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 text-[9px] font-black uppercase tracking-widest hover:text-indigo-600 hover:border-indigo-200 transition-colors"
          @click="showAdvanced = true"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
          Advanced Options
        </button>
      </div>

      <!-- Settings most players can leave at their defaults live in a modal so the panel stays simple. -->
      <Teleport to="body">
        <div v-if="showAdvanced" class="fixed inset-0 z-[2000] flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm transition-all" @click="showAdvanced = false" />
          <div
            class="relative w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl rounded-2xl border border-white/50 bg-white/95 transition-all duration-300 animate-in fade-in zoom-in-95"
          >
            <div class="bg-gradient-to-r from-slate-50 to-white px-6 py-4 border-b border-slate-100">
              <h3 class="text-xs font-black text-slate-800 uppercase tracking-widest">Advanced Options</h3>
              <p class="text-[10px] font-bold text-slate-400 mt-1">The defaults work well for most players.</p>
            </div>
            <div class="px-6 py-5 space-y-5 overflow-y-auto">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Max lifetime shifts</label>
                  <input v-model="maxShiftsInput" type="number" min="0" step="1" placeholder="No cap" :class="inputClass" class="w-full" />
                  <p class="text-[10px] font-bold text-slate-400 px-1">Now: {{ currentShiftCount }}</p>
                </div>
                <div class="space-y-1.5">
                  <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Min SE to keep</label>
                  <input v-model="settings.minSoulEggs" type="text" placeholder="No floor, e.g. 5N" :class="inputClass" class="w-full" />
                  <p class="text-[10px] font-bold px-1" :class="budget.error ? 'text-red-500' : 'text-slate-400'">
                    {{ budget.error ?? `Now: ${formatNumber(soulEggs)}` }}
                  </p>
                </div>
              </div>

              <p class="text-[10px] font-bold text-slate-500 px-1">
                Shift budget:
                <span class="text-slate-800">{{ budgetLabel }}</span>
              </p>

              <div class="space-y-2">
                <label class="flex items-center gap-2 text-[10px] font-black text-slate-600 uppercase tracking-widest px-1 cursor-pointer">
                  <input v-model="awakeHours.enabled" type="checkbox" class="rounded text-indigo-600" />
                  Only shift while I'm awake
                </label>
                <div v-if="awakeHours.enabled" class="flex items-center gap-3 px-1">
                  <input v-model="awakeHours.start" type="time" :class="inputClass" class="w-32" />
                  <span class="text-[10px] font-black text-slate-400 uppercase">to</span>
                  <input v-model="awakeHours.end" type="time" :class="inputClass" class="w-32" />
                </div>
                <p class="text-[10px] font-bold text-slate-400 leading-relaxed px-1">
                  The TE-earning shifts (K3, C4, I2, R2, H2) are reordered and timed so that each one, and the end of
                  every ascension, happens while you're awake. This applies to Generate too. Build-phase shifts (C1
                  through H1) aren't adjusted yet.
                </p>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Search precision</label>
                  <select v-model.number="settings.precision" :class="inputClass" class="w-full">
                    <option value="sale">Sale-aligned stops (recommended, fastest)</option>
                    <option :value="1">Every TE (exhaustive, slowest; for double-checking)</option>
                    <option :value="2">Every 2 TE, then refine</option>
                    <option :value="5">Every 5 TE, then refine</option>
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Highest intermediate stop</label>
                  <input v-model="maxStopInput" type="number" min="0" step="1" placeholder="No cap" :class="inputClass" class="w-full" />
                  <p class="text-[10px] font-bold text-slate-400 px-1">
                    Once research is maxed, another ascension only adds a rebuild. The final ascension can still go higher.
                  </p>
                </div>
              </div>

              <div class="space-y-1.5">
                <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest px-1">Parallel workers</label>
                <input
                  v-model="workerCountInput"
                  type="number"
                  min="1"
                  :max="cores"
                  step="1"
                  :placeholder="`Auto (${defaultWorkers})`"
                  :class="inputClass"
                  class="w-full sm:w-48"
                />
                <p class="text-[10px] font-bold text-slate-400 px-1">
                  This device reports {{ cores }} cores. More workers search faster, up to a point, but each one uses
                  memory.
                </p>
              </div>
            </div>
            <div class="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                class="px-6 py-2 text-[10px] font-black uppercase tracking-widest bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-all rounded-xl hover:shadow-sm"
                @click="showAdvanced = false"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- The bad input is hidden in Advanced Options, so say why Optimize is disabled. -->
      <p v-if="budget.error" class="text-[10px] font-bold text-red-500 px-1">
        Advanced Options: {{ budget.error }}
      </p>

      <button
        v-if="!isOptimizing"
        type="button"
        class="w-full py-3 rounded-2xl bg-white border border-indigo-200 text-indigo-700 text-xs font-black uppercase tracking-[0.2em] hover:bg-indigo-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="isBusy || !!budget.error"
        @click="emit('optimize')"
      >
        <span class="flex flex-col items-center gap-0.5">
          <span>Optimize Path</span>
          <span class="text-[9px] font-bold normal-case tracking-normal opacity-70">(Caution, can take several minutes)</span>
        </span>
      </button>
      <div v-else class="space-y-3">
        <div class="flex items-center gap-3">
          <div class="flex-1 text-[10px] font-bold text-indigo-700 font-mono truncate">{{ progress || 'Optimizing...' }}</div>
          <button
            type="button"
            class="px-4 py-2 rounded-xl bg-white border border-red-200 text-red-600 text-[10px] font-black uppercase tracking-widest hover:bg-red-50"
            @click="emit('cancel')"
          >
            Cancel
          </button>
        </div>
        <OptimizerStatusLines
          v-if="status"
          :status="status"
          :start-t-e="startTE"
          :timezone="timezone"
          class="font-bold text-slate-600"
        />
      </div>

      <div v-if="notice" class="rounded-xl bg-amber-50 border border-amber-200 px-4 py-2 text-[11px] font-bold text-amber-800">
        {{ notice }}
      </div>

      <div v-if="result" class="rounded-xl bg-white border border-slate-200 p-4 space-y-3 text-xs text-slate-700">
        <div class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Fastest plan by number of ascensions</div>
        <div
          v-for="(plan, i) in result.byAscensions"
          :key="i"
          class="flex items-start gap-3 rounded-lg p-2"
          :class="i === result.appliedIndex ? 'bg-indigo-50 border border-indigo-200' : 'border border-transparent'"
        >
          <div class="flex-1 space-y-0.5">
            <div class="font-black text-slate-900">{{ pathLabel(plan) }}</div>
            <div>
              {{ plan.endTE }} TE on <span class="font-bold">{{ formatTime(plan.arrival) }}</span>
              · {{ plan.legs.length }} ascension{{ plan.legs.length === 1 ? '' : 's' }}
              · {{ plan.shiftsUsed }} shifts
              · {{ formatNumber(plan.endSoulEggs) }} SE left
            </div>
            <div v-if="result.refinedOnlyBest && i !== result.byAscensions.length - 1" class="text-[10px] text-slate-400">
              Fastest on the search grid (only the overall best is refined)
            </div>
          </div>
          <span
            v-if="i === result.appliedIndex"
            class="text-[9px] font-black text-indigo-600 uppercase tracking-widest whitespace-nowrap pt-0.5"
          >
            Generated
          </span>
          <button
            v-else
            type="button"
            class="px-3 py-1.5 rounded-lg bg-white border border-indigo-200 text-indigo-700 text-[9px] font-black uppercase tracking-widest hover:bg-indigo-600 hover:text-white transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="isBusy || isOptimizing"
            @click="emit('use-plan', i)"
          >
            Use this path
          </button>
        </div>
        <div v-if="mismatch" class="text-amber-700">
          The generated plan ends {{ formatTime(result.generatedEnd!) }}, which differs from the optimizer's
          prediction. Please report this.
        </div>
        <div class="text-[10px] text-slate-400">
          {{ result.buildCount }} build phases simulated in {{ (result.elapsedMs / 1000).toFixed(1) }}s
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAutoPlannerStore } from '@/stores/autoPlanner';
import { useVirtueStore } from '@/stores/virtue';
import { useInitialStateStore } from '@/stores/initialState';
import { computeShiftBudget } from '@/auto/se-tracker';
import { formatNumber, formatDateTimeWithYear } from '@/lib/format';
import type { OptimizerPlan, OptimizerStatus } from '@/auto/optimizer';
import type { OptimizerRun } from '@/auto/useAscensionGenerator';
import OptimizerStatusLines from './OptimizerStatusLines.vue';
import { availableCores, defaultPoolSize } from '@/auto/optimizerWorkerPool';

const props = defineProps<{
  isBusy: boolean;
  isOptimizing: boolean;
  progress: string;
  result: OptimizerRun | null;
  status: OptimizerStatus | null;
  notice: string | null;
  startTE: number;
}>();

const emit = defineEmits<{
  optimize: [];
  cancel: [];
  'use-plan': [index: number];
}>();

const { optimizerSettings: settings, awakeHours, timezone } = storeToRefs(useAutoPlannerStore());
const virtueStore = useVirtueStore();
const initialStateStore = useInitialStateStore();

const showAdvanced = ref(false);

const inputClass =
  'bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500/50 transition-all';

const modeOptions = [
  { value: 'te', label: 'Fastest to TE' },
  { value: 'deadline', label: 'Most TE by date' },
] as const;

const currentShiftCount = computed(() => virtueStore.initialShiftCount);
const soulEggs = computed(() => initialStateStore.soulEggs);

// <input type="number"> reports '' when cleared; the store wants null for "no cap".
const maxShiftsInput = computed({
  get: () => settings.value.maxLifetimeShifts ?? '',
  set: (value: string | number) => {
    settings.value.maxLifetimeShifts = value === '' || value === null ? null : Math.max(0, Math.floor(Number(value)));
  },
});

const cores = availableCores();
const defaultWorkers = defaultPoolSize();
const workerCountInput = computed({
  get: () => settings.value.workerCount ?? '',
  set: (value: string | number) => {
    settings.value.workerCount =
      value === '' || value === null ? null : Math.min(cores, Math.max(1, Math.floor(Number(value))));
  },
});

const maxStopInput = computed({
  get: () => settings.value.maxStopTE ?? '',
  set: (value: string | number) => {
    settings.value.maxStopTE = value === '' || value === null ? null : Math.max(0, Math.floor(Number(value)));
  },
});

const budget = computed(() =>
  computeShiftBudget(currentShiftCount.value, soulEggs.value, settings.value.maxLifetimeShifts, settings.value.minSoulEggs)
);

const budgetLabel = computed(() => {
  const b = budget.value;
  if (b.error) return '—';
  if (!isFinite(b.budget)) return 'unlimited';
  const limitedBy = b.budget === b.byLifetimeCap ? 'max lifetime shifts' : 'min SE to keep';
  return `${b.budget} more shifts (about ${Math.floor(b.budget / 13)} ascensions), limited by ${limitedBy}`;
});

const pathLabel = (plan: OptimizerPlan) => [props.startTE, ...plan.legs.map(l => l.targetTE)].join(' → ') + ' TE';

// The generated plan is the applied row; it should end exactly when that row predicted.
const mismatch = computed(() => {
  const result = props.result;
  const applied = result?.byAscensions[result.appliedIndex];
  return !!result?.generatedEnd && !!applied && Math.abs(result.generatedEnd - applied.arrival) > 60;
});

const formatTime = (timestamp: number) => formatDateTimeWithYear(timestamp, timezone.value);
</script>
