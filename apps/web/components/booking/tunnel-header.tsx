'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';

interface BookingTunnelHeaderProps {
  readonly tenantName: string;
  /** La vitrine du salon — la seule sortie du tunnel. */
  readonly exitHref: string;
  /**
   * Le retour à l'étape précédente, ou `null` quand il n'y en a pas : la
   * première étape, et l'écran de confirmation, qui est terminal (#732).
   *
   * `null` plutôt qu'un bouton désactivé : une cible tactile grisée en tête
   * d'écran laisse croire qu'il manque une condition à remplir, là où il n'y a
   * simplement rien derrière.
   */
  readonly onBack: (() => void) | null;
  /**
   * Des choix ou des saisies existent, et quitter les perdrait.
   *
   * C'est ce qui distingue les deux sorties : un tunnel qu'on vient d'ouvrir se
   * quitte d'un lien, sans rien demander ; un tunnel où l'on a déjà tapé son
   * nom demande confirmation, parce que le brouillon meurt avec l'onglet
   * (`lib/booking/draft.ts` : `sessionStorage`).
   */
  readonly unsavedWork: boolean;
}

/**
 * L'en-tête du tunnel de réservation (#1047) — revenir, et sortir.
 *
 * ## Ce qu'il remplace
 *
 * Le tunnel ouvrait sur le bandeau d'une page ordinaire : surcapitale « SPA
 * LUMIÈRE », titre « Prendre rendez-vous », phrase d'accroche qui redisait le
 * titre, et un pied de page portant les sorties du salon. Trois lignes de
 * décor, aucune commande, et la navigation du site restait à l'écran pendant
 * qu'on réservait (audit `d20260918-1`).
 *
 * `BM-TUNNEL-10` (`docs/design/benchmark/parcours-client.md`) dit ce que font
 * Fresha et Treatwell à cet endroit : *« la navigation du site disparaît au
 * profit d'un "←" (étape précédente) et d'un "×" (quitter), en cibles tactiles
 * larges »*. C'est exactement ce que cet en-tête porte, et rien d'autre.
 *
 * ## Pourquoi il n'est pas `SalonShell`
 *
 * Le gabarit public du salon (#1045) porte l'entrée du compte, « Prendre
 * rendez-vous » et un pied de page de trois colonnes : tout ce dont le tunnel
 * doit se défaire. `salon-shell.tsx` l'écrit lui-même — *« Le tunnel de
 * réservation n'est pas servi ici : son en-tête se réduit à revenir et sortir
 * (BM-TUNNEL-10), c'est l'objet de #1047 »*. L'identité du salon est reprise
 * telle quelle — même `Avatar` carré au ton `brand`, même mesure — pour que
 * passer de la vitrine au tunnel ne se lise pas comme un changement de produit.
 *
 * ## Le monogramme et le nom ne mènent nulle part
 *
 * Ce sont un repère, pas une navigation : un troisième lien dans une barre qui
 * n'en veut que deux rendrait la sortie moins claire, et c'est précisément ce
 * que le motif corrige. La vitrine reste atteignable par « Quitter ».
 */
export function BookingTunnelHeader({
  tenantName,
  exitHref,
  onBack,
  unsavedWork,
}: BookingTunnelHeaderProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <header className="spa-booking__header">
      {/* Bande intérieure bornée, bandeau plein : le même partage que
          `.spa-shell__header` / `.spa-shell__bar` (#1045), sans quoi le fond et
          le filet de l'en-tête s'arrêteraient au milieu d'un écran large. */}
      <div className="spa-booking__header-bar">
        {/* Les deux joues de la barre sont rendues même vides : ce sont elles
            qui tiennent le nom du salon au centre, quelle que soit l'étape.
            Sans elles, le nom se décalerait d'une cible tactile en arrivant à
            la première étape, où il n'y a rien à quoi revenir. */}
        <div className="spa-booking__header-side">
          {onBack === null ? null : (
            <button type="button" className="spa-booking__header-action" onClick={onBack}>
              {/* Le socle ne porte pas de flèche vers la gauche : c'est la même
                  flèche, retournée par la feuille (`booking.css`). Ajouter un
                  tracé à `components/ui/icon.tsx` pour une rotation de 180°
                  ferait deux dessins à maintenir pour une seule forme. */}
              <Icon name="arrow" className="spa-booking__header-arrow" />
              <span className="spa-booking__header-label">Retour</span>
            </button>
          )}
        </div>

        <p className="spa-booking__header-salon">
          {/* Décoratif : le nom est écrit juste à côté, et un `label` le ferait
              entendre deux fois (`components/ui/avatar.tsx`). */}
          <Avatar name={tenantName} shape="square" tone="brand" size="sm" />
          <span className="spa-booking__header-name">{tenantName}</span>
        </p>

        <div className="spa-booking__header-side spa-booking__header-side--end">
          {unsavedWork ? (
            <button
              type="button"
              className="spa-booking__header-action"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Icon name="close" />
              <span className="spa-booking__header-label">Quitter</span>
            </button>
          ) : (
            // Rien n'a encore été choisi : la sortie est une navigation
            // ordinaire, qui s'ouvre dans un nouvel onglet et se suit comme un
            // lien.
            <Link className="spa-booking__header-action" href={exitHref}>
              <Icon name="close" />
              <span className="spa-booking__header-label">Quitter</span>
            </Link>
          )}
        </div>
      </div>

      {/*
        La confirmation de sortie — `Sheet` et non une modale écrite ici.

        C'est la brique du socle pour un choix secondaire (#1044) : elle monte
        du bas au pouce, s'ouvre sur le côté au-delà de 48 rem, et tient d'un
        `<dialog>` le piège de focus, la fermeture par Échap et le retour du
        focus au bouton qui l'a ouverte. Rien de tout cela n'aurait à être
        réécrit ici.

        « Rester » est l'action de droite et le seul bouton plein : c'est le
        choix sûr, et il doit l'être aussi sous le pouce.

        La phrase dit ce qui est **vrai** : quitter vers la vitrine ne détruit
        rien, le brouillon vit dans `sessionStorage` et survit à la navigation
        (`lib/booking/draft.ts`). Ce que la confirmation protège, c'est la
        sortie elle-même — on ne quitte pas un tunnel de réservation par
        inadvertance —, et ce qui est perdu l'est à la fermeture de l'onglet,
        pas au clic. Annoncer une perte qui n'a pas lieu ferait de cette
        confirmation un épouvantail.
      */}
      <Sheet
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title="Quitter la réservation ?"
        footer={
          <>
            <Link className="spa-button spa-button--quiet" href={exitHref}>
              <span className="spa-button__label">Quitter sans réserver</span>
            </Link>
            <Button
              variant="accent"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Rester
            </Button>
          </>
        }
      >
        <p>
          Votre rendez-vous n’est pas encore pris. Votre prestation, votre créneau et vos
          coordonnées restent enregistrés le temps de cet onglet : vous les retrouverez en
          revenant ici.
        </p>
      </Sheet>
    </header>
  );
}
