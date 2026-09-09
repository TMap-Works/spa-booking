'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { buildReportCsv, reportCsvFilename, type ReportCsvInput } from '@/lib/admin/reporting-csv';

/**
 * L'export CSV — quatrième critère de #75.
 *
 * ## Pourquoi le fichier est fabriqué dans le navigateur
 *
 * Le critère demande « l'export CSV des **données affichées** ». Fabriquer le
 * fichier ici, à partir des chiffres que la page vient de peindre, est la seule
 * façon d'en être certain : une seconde requête, même à la même période, pourrait
 * rendre autre chose — un encaissement de plus, un rendez-vous marqué honoré
 * entre-temps — et la gérante aurait sous les yeux un tableau que son fichier
 * contredit.
 *
 * Cela vaut aussi une propriété qui n'est pas rien : **aucune donnée ne repart
 * vers un serveur pour être exportée**. Le fichier ne quitte pas le poste.
 *
 * ## Ce que cet export **n'est pas**, et c'est écrit dans l'issue
 *
 * Le cinquième critère de #75 demande un fichier « préfixé par le tenant et
 * servi par URL présignée ». La première moitié est tenue —
 * `reportCsvFilename` préfixe par le slug de l'établissement. La seconde ne peut
 * pas l'être depuis `apps/web` : une URL présignée suppose un objet déposé dans
 * un bucket et signé par un porteur d'identifiants AWS, c'est-à-dire une route
 * d'API et un module Terraform. Le dépôt n'en a aucun aujourd'hui — ni bucket
 * d'export, ni SDK S3 côté `apps/api`. Le critère reste donc **ouvert**, suivi
 * par une issue dédiée, plutôt que simulé par un lien de téléchargement qu'on
 * appellerait présigné.
 *
 * ## Le bouton se désactive pendant la fabrication
 *
 * Même règle que les soumissions du parcours (web-frontend §3) : un double clic
 * ne produit pas deux fichiers. La sérialisation d'une année de données est
 * courte mais pas instantanée, et c'est exactement l'intervalle pendant lequel
 * on reclique.
 */

interface ReportExportButtonProps {
  readonly tenantSlug: string;
  /** Exactement ce que l'écran affiche — voir l'en-tête de `reporting-csv.ts`. */
  readonly data: ReportCsvInput;
}

export function ReportExportButton({ tenantSlug, data }: ReportExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const download = (): void => {
    setBusy(true);
    setFailure(null);

    try {
      const filename = reportCsvFilename(tenantSlug, data.range);
      // `text/csv;charset=utf-8` **et** la marque d'ordre d'octets que pose
      // `buildReportCsv` : le type MIME ne suffit pas à faire lire l'UTF-8 au
      // tableur, qui se fie à la marque.
      const blob = new Blob([buildReportCsv(data)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');

      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Révoqué au tour de boucle suivant : révoquer dans la foulée du clic
      // annule le téléchargement sur certains navigateurs, qui n'ont pas encore
      // lu l'objet.
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);

      setDownloaded(filename);
    } catch (error) {
      setDownloaded(null);
      setFailure(
        error instanceof Error
          ? `L’export n’a pas pu être produit : ${error.message}`
          : 'L’export n’a pas pu être produit.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="spa-admin-report-export">
      <Button
        type="button"
        variant="neutral"
        loading={busy}
        loadingLabel="Préparation…"
        onClick={download}
      >
        Exporter en CSV
      </Button>
      <p aria-live="polite" className="spa-admin-report-export__status">
        {failure ?? (downloaded === null ? '' : `Fichier téléchargé : ${downloaded}`)}
      </p>
    </div>
  );
}
