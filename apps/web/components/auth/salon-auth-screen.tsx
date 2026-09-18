import type { PublicTenant } from '@spa/shared';
import type { ReactNode } from 'react';

import { openingStatus } from '@/components/salon/opening-hours';
import { addressLines } from '@/components/salon/salon-address';
import { Avatar } from '@/components/ui/avatar';
import { Icon, type IconName } from '@/components/ui/icon';

/**
 * Le cadre d'accueil de la connexion et de l'inscription **clientes** (#1052).
 *
 * ## Ce qu'il corrige
 *
 * L'audit `d20260918-1`, critère `ds:mobile` : sur les deux écrans, le volet
 * sombre ouvrait sur « Spa & Salon Booking », reléguait le salon à une
 * surcapitale, et poussait le premier champ à 270 px sur un téléphone de
 * 360 px. Une cliente qui vient de la vitrine du Salon des Lilas y lisait
 * d'abord le nom d'un éditeur dont elle n'a que faire — et devait défiler pour
 * atteindre le champ qu'elle est venue remplir.
 *
 * Ici, le salon est le premier élément lu : son monogramme, son nom, et un
 * titre qui l'adresse (« Bienvenue chez Maison Lotus »). La plateforme n'est
 * plus nommée dans le cadre du tout — le pied du gabarit du salon la porte en
 * mention « propulsé par » (#1045), ce qui est sa place.
 *
 * ## Pourquoi un composant distinct d'`auth-screen.tsx`
 *
 * L'autre cadre (#927) sert les écrans des espaces de **travail** : la connexion
 * du back-office, l'invitation d'un praticien et la console de l'éditeur.
 * Ceux-là n'ont pas de salon à mettre en avant — la console n'en a aucun —, et
 * leur volet d'accueil dit ce que l'espace ouvre, ce qui est la bonne réponse
 * pour un outil de travail. Les faire passer par les mêmes props aurait demandé
 * d'y ajouter deux variantes conditionnelles pour ne jamais les employer. Le
 * critère d'acceptation du ticket l'autorise explicitement : « le cadre partagé
 * ne régresse pas — ou la variante client s'en sépare proprement ». Elle s'en
 * sépare — et #1080 en a tiré la conséquence : `auth-screen.tsx` n'a plus de
 * branche « espace client », c'est le cadre des espaces de travail.
 *
 * Les deux cadres gardent en revanche les mêmes classes de structure
 * (`spa-auth__frame`, `spa-auth__intro`, `spa-auth__panel`) : c'est la même
 * mise en page à deux volets, et la dupliquer en CSS l'aurait fait diverger.
 * Seul `spa-auth--salon` distingue celui-ci — `spa-auth--client`, qui le
 * doublait sans qu'aucune règle ne le vise, est tombé avec la prop `space` à
 * laquelle il faisait écho (#1080).
 *
 * ## Server Component
 *
 * Du texte, une pastille d'initiales et deux faits lus sur la fiche publique.
 * L'état vit dans le formulaire que l'appelant pose dans `children`.
 */

export type SalonAuthIntent = 'connexion' | 'inscription';

interface SalonAuthCopy {
  /** Le titre, salon nommé — et son repli quand la fiche n'a pas pu être lue. */
  readonly headline: (salonName: string) => string;
  readonly fallbackHeadline: string;
  readonly lead: string;
}

/**
 * Ce que chaque écran annonce.
 *
 * Écrit ici et non dans les pages : les deux titres ne se lisent bien que l'un
 * à côté de l'autre — « Bienvenue chez … » accueille qui revient, « Créez votre
 * compte … » s'adresse à qui arrive —, et deux fichiers les auraient laissés
 * diverger de ton au premier remaniement.
 */
const COPY: Readonly<Record<SalonAuthIntent, SalonAuthCopy>> = {
  connexion: {
    headline: (salonName) => `Bienvenue chez ${salonName}`,
    fallbackHeadline: 'Bienvenue',
    lead: 'Retrouvez vos rendez-vous, votre historique et vos coordonnées.',
  },
  inscription: {
    headline: (salonName) => `Créez votre compte ${salonName}`,
    fallbackHeadline: 'Créez votre compte',
    lead: 'Réservez plus vite, reportez ou annulez en ligne, gardez vos rappels à jour.',
  },
};

/** Un fait porté par le volet d'accueil — où est le salon, et s'il est ouvert. */
interface SalonFact {
  readonly icon: IconName;
  readonly lines: readonly string[];
}

interface SalonAuthScreenProps {
  /** La fiche publique, ou `null` quand l'API n'a pas répondu. */
  readonly tenant: PublicTenant | null;
  readonly intent: SalonAuthIntent;
  /**
   * Le rang du titre — `h1` par défaut, `p` quand le gabarit en porte déjà un.
   *
   * Le cas n'est pas théorique : `session/refresh` **conserve** les cookies
   * quand le renouvellement échoue pour autre chose qu'un refus, et renvoie sur
   * `/compte/connexion?motif=renouvellement-indisponible` (#860). Le gabarit
   * prend alors sa branche « connecté·e » et écrit « Bonjour Marie » en `h1` ;
   * un second `h1` ici donnerait deux titres de premier niveau sur le même
   * écran. C'est le seul cadre à garder ce réglage : celui des espaces de
   * travail laisse toujours le `<h1>` au formulaire (`auth-screen.tsx`, #1080).
   */
  readonly headlineAs?: 'h1' | 'p';
  /**
   * L'instant auquel l'état d'ouverture est calculé.
   *
   * Paramètre plutôt que `new Date()` enfoui : c'est ce qui rend l'écran
   * vérifiable sans geler l'horloge du processus. Les deux pages sont rendues à
   * chaque requête (`force-dynamic`), l'instant est donc toujours le bon.
   */
  readonly now?: Date;
  readonly children: ReactNode;
}

/**
 * Ce que le volet d'accueil sait du salon — et rien de plus.
 *
 * Un salon qui n'a publié ni adresse ni horaires ne produit aucun fait, et le
 * volet se borne alors à son identité : trois puces génériques valaient moins
 * que le silence, c'est le constat même de l'audit.
 */
function salonFacts(tenant: PublicTenant, now: Date): readonly SalonFact[] {
  const facts: SalonFact[] = [];

  if (tenant.address !== undefined) {
    // Une ligne vide est possible — un salon sans code postal ni ville en
    // produit une —, et un `<span>` creux ouvrirait une ligne blanche dans
    // l'adresse.
    const lines = addressLines(tenant.address).filter((line) => line !== '');

    if (lines.length > 0) {
      facts.push({ icon: 'pin', lines });
    }
  }

  const opening = openingStatus(tenant.openingHours ?? [], tenant.timezone, now);

  if (opening !== null) {
    facts.push({ icon: 'clock', lines: [opening.label] });
  }

  return facts;
}

export function SalonAuthScreen({
  tenant,
  intent,
  headlineAs: Headline = 'h1',
  now = new Date(),
  children,
}: SalonAuthScreenProps) {
  const copy = COPY[intent];
  const salonName = tenant?.name ?? null;
  const headline = salonName === null ? copy.fallbackHeadline : copy.headline(salonName);
  const facts = tenant === null ? [] : salonFacts(tenant, now);

  return (
    <div className="spa-auth spa-auth--salon">
      <div className="spa-auth__frame">
        <div className="spa-auth__intro">
          {/*
            Rien plutôt qu'un paragraphe vide quand la fiche n'a pas pu être
            lue : la gouttière du volet creuserait sinon 24 px de blanc autour
            d'une identité absente.

            Le nom écrit à côté du monogramme n'est montré qu'à partir de
            56 rem : sous ce palier, le titre le porte déjà (« Bienvenue chez
            Maison Lotus »), et le redire coûterait la moitié de la bande dont
            l'audit demande précisément qu'elle tienne en 96 px.
          */}
          {salonName === null ? null : (
            <p className="spa-auth__identity">
              <Avatar name={salonName} shape="square" tone="brand" size="sm" />
              <span className="spa-auth__salon-name">{salonName}</span>
            </p>
          )}

          <div className="spa-auth__welcome">
            <Headline className="spa-auth__headline">{headline}</Headline>
            <p className="spa-auth__lead">{copy.lead}</p>
          </div>

          {facts.length === 0 ? null : (
            <ul className="spa-auth__facts" aria-label="Le salon en bref">
              {facts.map((fact) => (
                <li className="spa-auth__fact" key={fact.icon}>
                  <span className="spa-auth__fact-badge">
                    <Icon name={fact.icon} />
                  </span>
                  {/* Indexées comme dans le pied du gabarit : deux lignes d'une
                      même adresse peuvent être identiques, et une clé en
                      doublon fait taire React sur celle qui bouge. */}
                  <span className="spa-auth__fact-lines">
                    {fact.lines.map((line, index) => (
                      <span key={index}>{line}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="spa-auth__panel">{children}</div>
      </div>
    </div>
  );
}
