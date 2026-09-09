'use client';

import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { adminSessionRefreshPath } from '../paths';
import {
  createReportExportAction,
  type ReportExportWindow,
} from '../reporting/actions';

/**
 * L'export CSV — quatrième critère de #75, et sa seconde moitié tenue par #563.
 *
 * ## Ce qui a changé, et ce que cela coûte
 *
 * #75 fabriquait le fichier **dans le navigateur**, à partir des chiffres que la
 * page venait de peindre, et c'était la seule façon d'être certain que le
 * fichier corresponde exactement à l'écran. Depuis #563, le fichier est
 * sérialisé **par l'API**, déposé dans un bucket sous une clé préfixée par
 * l'établissement, et servi par une URL présignée de quinze minutes au plus.
 *
 * La garantie « le fichier est ce que je vois » est donc perdue : une caisse
 * encaissée entre l'affichage et le clic apparaîtra dans le fichier sans être à
 * l'écran. L'échange est celui qu'exige le cinquième critère de #75 — une URL
 * présignée suppose un objet déposé par un porteur d'identifiants AWS,
 * c'est-à-dire un fichier produit côté serveur — et ce qu'on gagne n'est pas
 * mince : le fichier porte le détail complet des trois rapports plutôt que ce
 * qu'un écran a bien voulu peindre, et deux exports de la même fenêtre disent
 * la même chose.
 *
 * ## Le nom du fichier vient du serveur
 *
 * `filename` est rendu par l'API, préfixé par le slug de l'établissement, et le
 * `Content-Disposition` de l'objet le porte aussi. L'écran ne le recompose pas :
 * deux calculs du même nom finiraient par diverger, et c'est celui qui n'est pas
 * dans l'objet qu'on oublierait de corriger.
 *
 * ## L'URL est ouverte, jamais gardée
 *
 * Elle est **porteuse** : quiconque la détient lit le fichier jusqu'à son
 * échéance, sans jeton. Elle n'est donc ni mise en cache, ni écrite dans l'URL
 * de la page, ni conservée après le clic — le composant l'ouvre et l'oublie.
 * `rel="noopener"` sur le lien fabriqué pour la même raison qu'ailleurs : la
 * fenêtre ouverte n'a rien à savoir de celle-ci.
 *
 * ## Le bouton se désactive pendant la préparation
 *
 * Même règle que les soumissions du parcours (web-frontend §3) : un double clic
 * ne produit pas deux fichiers. Ici cela compte plus qu'avant — chaque clic
 * dépose réellement un objet dans un bucket, là où le `Blob` d'hier ne coûtait
 * qu'une allocation.
 *
 * ## Une session expirée se renouvelle, elle ne s'affiche pas
 *
 * Le `Blob` d'hier n'appelait personne : l'export ne pouvait pas buter sur un
 * jeton périmé. Il le peut désormais, et un tableau de bord se laisse ouvert
 * longtemps — c'est même l'écran où cela arrive le plus. `UNAUTHORIZED` part
 * donc vers la route de renouvellement, qui rend la main sur la période
 * affichée, comme le planning et le sélecteur de clientes le font déjà (#48,
 * #458). Afficher « votre session a expiré » aurait été un cul-de-sac là où un
 * aller-retour suffit.
 */

interface ReportExportButtonProps {
  readonly tenantSlug: string;
  /** La fenêtre affichée, déjà calculée dans le fuseau du salon. */
  readonly window: ReportExportWindow;
}

export function ReportExportButton({ tenantSlug, window: reportWindow }: ReportExportButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);

    const result = await createReportExportAction(tenantSlug, reportWindow);

    if (!result.ok) {
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        // `replace` et non `push` : un renouvellement n'est pas une destination,
        // et le laisser dans l'historique ferait renouveler une seconde fois au
        // premier retour arrière. La destination est l'écran **tel qu'il est
        // affiché**, période et filtre compris — lus de la barre d'adresse,
        // seule à les porter tous les deux.
        router.replace(
          adminSessionRefreshPath(
            tenantSlug,
            `${globalThis.location.pathname}${globalThis.location.search}`,
          ),
        );
        return;
      }

      setDownloaded(null);
      setFailure(
        result.code === ERROR_CODES.REPORT_EXPORT_UNAVAILABLE
          ? 'L’export n’est pas disponible sur cet environnement.'
          : `L’export n’a pas pu être produit : ${result.message}`,
      );
      setBusy(false);
      return;
    }

    // `globalThis.window` et non `window` : la prop du composant porte ce nom,
    // et l'ombrer ici rendrait la lecture ambiguë à l'endroit où elle ne doit
    // pas l'être.
    const anchor = globalThis.document.createElement('a');

    anchor.href = result.data.url;
    anchor.download = result.data.filename;
    anchor.rel = 'noopener';
    globalThis.document.body.append(anchor);
    anchor.click();
    anchor.remove();

    setDownloaded(result.data.filename);
    setBusy(false);
  };

  return (
    <div className="spa-admin-report-export">
      <Button
        type="button"
        variant="neutral"
        loading={busy}
        loadingLabel="Préparation…"
        onClick={() => {
          void download();
        }}
      >
        Exporter en CSV
      </Button>
      <p aria-live="polite" className="spa-admin-report-export__status">
        {failure ?? (downloaded === null ? '' : `Fichier téléchargé : ${downloaded}`)}
      </p>
    </div>
  );
}
