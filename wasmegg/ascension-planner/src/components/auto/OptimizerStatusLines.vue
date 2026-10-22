<template>
  <div class="space-y-1 text-[10px] leading-snug">
    <div v-if="status.best">
      <span class="font-black uppercase tracking-widest opacity-70">Best so far:</span>
      {{ [startTE, ...status.best.stops].join(' → ') }} TE · {{ formatDateTime(status.best.arrival) }}
    </div>
    <div v-for="(run, i) in status.running" :key="i" class="truncate">
      Building from {{ run.fromTE }} TE (A{{ run.ascension }}, starts {{ formatDate(run.startTime) }}) → every stop up
      to {{ status.goalTE }}
      <span v-if="run.stops.length > 0" class="opacity-60">· via {{ [startTE, ...run.stops].join(' → ') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OptimizerStatus } from '@/auto/optimizer';
import { formatDateTimeWithYear } from '@/lib/format';

const props = defineProps<{
  status: OptimizerStatus;
  startTE: number;
  timezone: string;
}>();

// Plans run for years, so unlike the planner's usual formatAbsoluteTime these include the year.
const formatDate = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: props.timezone,
  });

const formatDateTime = (timestamp: number) => formatDateTimeWithYear(timestamp, props.timezone);
</script>
