import { describe, expect, it } from 'vitest';

import { groupSecret } from '@/app/plateforme/components/platform-code-form';
import { qrPath } from '@/app/plateforme/components/totp-qr-code';

/**
 * Le QR code d'enrôlement de la console, et la clé qui l'accompagne (#1442).
 *
 * Le dessin lui-même se vérifie à l'œil et à la caméra en recette ; ce qui se
 * vérifie ici, c'est ce qui ne se voit pas : la marge que la norme exige, et
 * le tracé des trois motifs de détection sans lesquels aucun lecteur ne trouve
 * le code.
 */

const URI =
  'otpauth://totp/Spa%20Booking:ops%40spa.test?secret=ABCDEFGHABCDEFGHABCDEFGHABCDEFGH' +
  '&issuer=Spa+Booking&algorithm=SHA1&digits=6&period=30';

describe('qrPath', () => {
  it('entoure le code d’une marge de quatre modules', () => {
    const { path, size } = qrPath(URI);
    const modules = [...path.matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => [Number(x), Number(y)]);

    expect(modules.length).toBeGreaterThan(0);
    expect(Math.min(...modules.map(([x]) => x ?? 0))).toBe(4);
    expect(Math.min(...modules.map(([, y]) => y ?? 0))).toBe(4);
    expect(Math.max(...modules.map(([x]) => x ?? 0))).toBe(size - 5);
  });

  it('pose un motif de détection plein au coin supérieur gauche', () => {
    const { path } = qrPath(URI);

    // Le centre 3 × 3 d'un motif de détection est noir : modules (2..4, 2..4)
    // du code, soit (6..8, 6..8) une fois la marge ajoutée.
    for (const x of [6, 7, 8]) {
      for (const y of [6, 7, 8]) {
        expect(path).toContain(`M${String(x)} ${String(y)}h1v1h-1z`);
      }
    }
  });
});

describe('groupSecret', () => {
  it('groupe la clé par quatre, sans espace final', () => {
    expect(groupSecret('ABCDEFGHABCDEFGHABCDEFGHABCDEFGH')).toBe(
      'ABCD EFGH ABCD EFGH ABCD EFGH ABCD EFGH',
    );
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });
});
