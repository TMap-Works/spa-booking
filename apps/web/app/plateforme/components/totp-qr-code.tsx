import qrcode from 'qrcode-generator';
import { memo } from 'react';

/**
 * Le QR code d'enrôlement du second facteur de la console (#1442).
 *
 * Il encode l'URI `otpauth://` que rend le premier temps de la connexion, et
 * c'est tout ce qu'une application d'authentification attend : l'émetteur, le
 * compte, le secret, l'algorithme, la longueur et la période du code.
 *
 * ## Un SVG, dessiné ici
 *
 * `qrcode-generator` est déjà la bibliothèque de l'API pour le QR du ticket de
 * caisse (`receipt-pdf.qr.ts`) : sans dépendance, et exposant la seule
 * primitive utile — `isDark(ligne, colonne)`. Les modules noirs sont réunis en
 * **un seul chemin**, un carré `M x y h1 v1 h-1 z` par module : un `<rect>` par
 * module ferait plusieurs centaines de nœuds pour une image.
 *
 * ## Noir sur blanc, dans les deux thèmes
 *
 * `--spa-color-paper` et `--spa-color-ink` ne s'inversent pas en thème sombre,
 * pour la même raison que le ticket : un QR clair sur fond sombre n'est pas lu
 * par tous les lecteurs. La marge de quatre modules (`QUIET_ZONE`) est celle
 * que la norme exige autour du code.
 *
 * ## La correction d'erreur à M
 *
 * C'est un écran, pas du papier thermique : M (15 %) suffit largement, et une
 * URI `otpauth://` d'une centaine de caractères y tient dans une version qui
 * garde des modules assez gros pour une caméra de téléphone.
 */

/** La marge claire autour du code, en modules — ISO/IEC 18004 en demande quatre. */
const QUIET_ZONE = 4;

/**
 * Le chemin SVG des modules noirs, et la taille du carré marge comprise.
 *
 * Sans réglage d'encodage, contrairement au QR du ticket : `qrcode-generator`
 * encode en Latin-1, et l'URI qu'on lui passe est **ASCII par construction** —
 * l'API en code le libellé par `encodeURIComponent` et la requête par
 * `URLSearchParams` (`totp.ts`, `totpUri`). Le build ESM que le front charge
 * n'expose d'ailleurs pas `stringToBytesFuncs`.
 */
export function qrPath(text: string): { readonly path: string; readonly size: number } {
  const code = qrcode(0, 'M');

  code.addData(text);
  code.make();

  const count = code.getModuleCount();
  const segments: string[] = [];

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) {
        segments.push(`M${String(column + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`);
      }
    }
  }

  return { path: segments.join(''), size: count + QUIET_ZONE * 2 };
}

interface TotpQrCodeProps {
  /** L'URI `otpauth://` à encoder. */
  readonly value: string;
  /** Ce qu'annonce un lecteur d'écran à la place de l'image. */
  readonly label: string;
}

/**
 * Mémoïsé : l'écran du code se redessine à chaque changement d'état du
 * formulaire — envoi, refus —, et l'URI, elle, ne change pas. Le QR n'est
 * recalculé que pour une autre URI.
 */
export const TotpQrCode = memo(function TotpQrCode({ value, label }: TotpQrCodeProps) {
  const { path, size } = qrPath(value);

  return (
    <svg
      className="spa-auth-totp__qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
    >
      <rect className="spa-auth-totp__qr-paper" width={size} height={size} />
      <path className="spa-auth-totp__qr-ink" d={path} />
    </svg>
  );
});
