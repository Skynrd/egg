import { describe, expect, test } from 'vitest';
import { ei } from 'lib';
import { Inventory } from 'lib/artifacts/inventory';
import { modifiersFromColleggtibleTiers } from 'lib/collegtibles';
import { getOptimalELRSet } from '@/lib/artifacts/virtue';
import { backupForWorker } from './optimizerWorkerPool';

const { Name, Level, Rarity } = ei.ArtifactSpec;

// A T4 stone. Its rarity (COMMON = 0) is left out, as in real saves: a field that's absent from the
// wire decodes to the default kept on the message's prototype, not to an own property.
const stone = (name: ei.ArtifactSpec.Name) => ({ name, level: Level.NORMAL });

// Common-rarity stones and a T1 common artifact: default-valued fields protobufjs keeps on the
// prototype of a decoded message.
function decodedBackup(): ei.Backup {
  const item = (itemId: number, spec: object, stones: object[] = []) => ({ itemId, quantity: 1, artifact: { spec, stones } });
  const backup = ei.Backup.fromObject({
    game: { permitLevel: 1 },
    artifactsDb: {
      virtueAfxDb: {
        inventoryItems: [
          item(1, { name: Name.QUANTUM_METRONOME, level: Level.GREATER, rarity: Rarity.EPIC }, [
            stone(Name.TACHYON_STONE),
            stone(Name.TACHYON_STONE),
          ]),
          item(2, { name: Name.ORNATE_GUSSET, level: Level.GREATER, rarity: Rarity.LEGENDARY }, [
            stone(Name.QUANTUM_STONE),
            stone(Name.QUANTUM_STONE),
            stone(Name.QUANTUM_STONE),
          ]),
          item(3, { name: Name.LUNAR_TOTEM }),
          item(4, stone(Name.TACHYON_STONE)),
        ],
      },
    },
  });
  return ei.Backup.decode(ei.Backup.encode(backup).finish());
}

function haveCounts(backup: ei.IBackup) {
  const inventory = new Inventory(backup.artifactsDb!, { virtue: true });
  return inventory.items.filter(i => i.have > 0).map(i => `${i.id}:${i.have}`).sort();
}

const elrSet = (backup: ei.IBackup) =>
  getOptimalELRSet(backup, {
    assumeMaxHabsVehicles: true,
    commonResearch: {},
    epicResearchLevels: {},
    colleggtibleModifiers: modifiersFromColleggtibleTiers({}),
  });

describe('backupForWorker', () => {
  test('the decoded message really does hide default fields on its prototype', () => {
    const spec = decodedBackup().artifactsDb!.virtueAfxDb!.inventoryItems![3].artifact!.spec!;
    expect(Object.prototype.hasOwnProperty.call(spec, 'rarity')).toBe(false);
    expect(spec.rarity).toBe(Rarity.COMMON);
  });

  test('a plain copy loses them', () => {
    const original = decodedBackup();
    expect(() => haveCounts(structuredClone(original))).toThrow();
  });

  test('the worker copy reads exactly like the original, after crossing postMessage', () => {
    const original = decodedBackup();
    const copy = structuredClone(backupForWorker(original)!);
    expect(haveCounts(copy)).toEqual(haveCounts(original));
    expect(elrSet(copy)).toEqual(elrSet(original));
  });
});
