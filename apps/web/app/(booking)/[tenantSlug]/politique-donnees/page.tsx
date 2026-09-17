import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicExits } from '@/components/salon/public-exits';
import { ApiClientError } from '@/lib/api-client';
import { ACCOUNT_CONSENT, BOOKING_CONSENT, type ConsentCopy } from '@/lib/booking/consent';

import { BookingErrorNotice } from '../booking-error-notice';
import { accountPath, loadSalonTenant, reservationPath, salonPath, siteOrigin } from '../salon-data';

/**
 * La politique de données d'un établissement — quatrième critère de #790.
 *
 * ## Ce qu'elle répare
 *
 * `docs/design/appointments/wireframes.md`, étape 4, dessine « J'accepte les CGV
 * et **la politique de données** ». #734 a rendu les finalités en place, dans un
 * dépliant, faute de page à lier — et l'a écrit noir sur blanc dans l'en-tête de
 * `lib/booking/consent.tsx` : « un lien vers une page inexistante informe moins
 * que pas de lien du tout ». La page existe maintenant, et les deux blocs de
 * consentement la lient.
 *
 * Le dépliant n'a pas disparu pour autant, et ce n'est pas un doublon : il reste
 * ce qui se lit **sans cliquer**, c'est-à-dire le seul texte que la cliente est
 * sûre d'avoir eu sous les yeux au moment de cocher. Cette page-ci est le texte
 * complet, pour qui le veut — RGPD art. 12 demande une information « aisément
 * accessible », pas une information à deux endroits différents qui se
 * contrediraient.
 *
 * ## Elle se **dérive** des deux blocs, elle ne les recopie pas
 *
 * `BOOKING_CONSENT` et `ACCOUNT_CONSENT` sont importés et rendus tels quels. Une
 * seconde rédaction des mêmes finalités aurait divergé de la première au premier
 * changement de texte, et c'est précisément le défaut que l'en-tête de
 * `consent.tsx` dit vouloir éviter en n'écrivant les finalités qu'une fois. Ce
 * que cette page ajoute, elle l'ajoute : le responsable du traitement, la base
 * légale, la preuve conservée, les sous-traitants, et rien qui soit déjà dit
 * ailleurs.
 *
 * ## Server Component, et `(booking)` plutôt que `(account)`
 *
 * La page est **publique** : elle doit se lire sans compte, depuis le tunnel
 * comme depuis l'inscription, et se laisser indexer. Elle n'a aucun état, aucun
 * formulaire, aucun `use client` — comme la vitrine voisine, et pour les mêmes
 * raisons (skill web-frontend §1).
 *
 * Elle est posée sous `[tenantSlug]/` et non sous `reservation/` : le layout du
 * tunnel y poserait le bandeau « Prendre rendez-vous » et un second `<h1>`, sur
 * une page qui n'est pas une étape de réservation. Elle porte donc son propre
 * conteneur `.spa-salon`, celui de la vitrine.
 *
 * ## `force-dynamic`
 *
 * Même raison que ses deux voisines : le nom de l'établissement change sans que
 * le front en soit averti, et un prérendu au build appellerait l'API depuis le
 * runner de CI ou l'étape `build` de l'image Docker, où elle n'existe pas.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenantSlug } = await params;

  try {
    const tenant = await loadSalonTenant(tenantSlug);
    const title = `Politique de données — ${tenant.name}`;
    const description =
      `Quelles données ${tenant.name} collecte lorsque vous réservez ou créez un compte, ` +
      `à quoi elles servent, combien de temps elles sont conservées, et comment exercer vos droits.`;

    return {
      metadataBase: new URL(siteOrigin()),
      title,
      description,
      alternates: { canonical: `${salonPath(tenant.slug)}/politique-donnees` },
      // Indexable, et c'est le propos : une information qu'on ne trouve pas
      // n'est pas « aisément accessible » (RGPD art. 12). C'est aussi la page
      // qu'un visiteur cherche avant de confier quoi que ce soit.
      robots: { index: true, follow: true },
    };
  } catch (error) {
    // Même conduite que la vitrine : `generateMetadata` ne doit pas jeter, et le
    // `noindex` est réservé au 404 — une panne d'API n'est pas une consigne.
    if (error instanceof ApiClientError && error.status === 404) {
      return { title: 'Politique de données', robots: { index: false, follow: false } };
    }

    return { title: 'Politique de données' };
  }
}

/**
 * Une section « à quoi servent vos données », rendue depuis le bloc de
 * consentement de l'écran correspondant.
 *
 * Le libellé de la case (`copy.label`) est repris tel quel : c'est le texte
 * exact que la cliente accepte, et le lire ici sous une autre formulation
 * laisserait croire qu'elle a consenti à autre chose.
 */
function PurposeSection({
  copy,
  title,
  headingId,
}: {
  readonly copy: ConsentCopy;
  readonly title: string;
  readonly headingId: string;
}) {
  return (
    <section className="spa-salon__section" aria-labelledby={headingId}>
      <h2 className="spa-salon__section-title" id={headingId}>
        {title}
      </h2>
      <p>{copy.intro}</p>
      <ul className="spa-list">
        {copy.purposes.map((purpose) => (
          <li key={purpose.data}>
            <strong>{purpose.data}</strong> — {purpose.why}
          </li>
        ))}
      </ul>
      <p>
        La case à cocher de cet écran porte exactement ces mots :{' '}
        <em>« {copy.label} »</em>
      </p>
    </section>
  );
}

export default async function DataPolicyPage({ params }: PageProps) {
  const { tenantSlug } = await params;

  let tenantName: string;

  try {
    tenantName = (await loadSalonTenant(tenantSlug)).name;
  } catch (error) {
    // Établissement inconnu, désactivé, ou slug mal formé : l'API répond 404 sans
    // distinguer les trois, et c'est voulu — un 403 confirmerait l'existence de
    // l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    // La panne ne prive pas de la sortie : le slug de l'URL suffit à adresser
    // l'espace client, comme sur la vitrine.
    return (
      <div className="spa-salon">
        <PublicExits variant="header" exits={[{ key: 'compte', href: accountPath(tenantSlug) }]} />
        <main className="spa-salon__main" id="contenu">
          <BookingErrorNotice title="La politique de données n’a pas pu être chargée" error={error} />
        </main>
      </div>
    );
  }

  return (
    <div className="spa-salon">
      <PublicExits variant="header" exits={[{ key: 'compte', href: accountPath(tenantSlug) }]} />
      <main className="spa-salon__main" id="contenu">
        <header className="spa-salon__header">
          <p className="spa-salon__eyebrow">{tenantName}</p>
          <h1 className="spa-salon__title">Politique de données</h1>
          <p className="spa-salon__lede">
            Ce que {tenantName} collecte lorsque vous réservez ou créez un compte, à quoi cela
            sert, combien de temps c’est conservé, et ce que vous pouvez en demander à tout
            moment.
          </p>
        </header>

        <section className="spa-salon__section" aria-labelledby="responsable">
          <h2 className="spa-salon__section-title" id="responsable">
            Qui traite vos données
          </h2>
          <p>
            L’établissement <strong>{tenantName}</strong> décide de ce qui est collecté et de ce
            qui en est fait : c’est lui votre interlocuteur, et c’est à lui que s’adressent les
            demandes ci-dessous. Cette plateforme de réservation héberge et traite ces données
            pour son compte, et pour aucun autre usage.
          </p>
          <p>
            Vos données restent celles de cet établissement : elles ne sont partagées avec aucun
            autre salon utilisant la même plateforme.
          </p>
        </section>

        <PurposeSection
          copy={BOOKING_CONSENT}
          title="Quand vous prenez rendez-vous"
          headingId="reservation"
        />

        <PurposeSection
          copy={ACCOUNT_CONSENT}
          title="Quand vous créez un compte"
          headingId="compte"
        />

        <section className="spa-salon__section" aria-labelledby="base-legale">
          <h2 className="spa-salon__section-title" id="base-legale">
            Sur quelle base, et ce que nous en gardons comme preuve
          </h2>
          <p>
            La case à cocher des deux écrans est bloquante : le formulaire ne part pas tant
            qu’elle ne l’est pas.
          </p>
          <p>
            Quand vous <strong>prenez rendez-vous</strong>, cet accord est de surcroît
            enregistré avec la <strong>date et l’heure exactes</strong> auxquelles vous l’avez
            donné, parce que l’établissement doit pouvoir démontrer qu’il l’a bien reçu — et la
            réservation est refusée sans lui. Quand vous <strong>créez un compte</strong>, la
            case est aujourd’hui posée à l’écran seulement : elle conditionne l’envoi du
            formulaire, mais aucune preuve horodatée n’en est encore conservée.
          </p>
          <p>
            Trois traitements n’en dépendent pas, et il faut le dire : la confirmation de votre
            rendez-vous, le rappel de la veille et l’avis d’annulation relèvent de l’exécution du
            service que vous avez demandé. Les couper vous priverait précisément de ce que vous
            êtes venue chercher.
          </p>
        </section>

        <section className="spa-salon__section" aria-labelledby="destinataires">
          <h2 className="spa-salon__section-title" id="destinataires">
            Qui d’autre les voit
          </h2>
          <ul className="spa-list">
            <li>
              <strong>L’équipe de l’établissement</strong> — les personnes qui tiennent l’agenda
              et le comptoir.
            </li>
            <li>
              <strong>Les services d’envoi</strong> — un prestataire d’e-mail et un prestataire de
              SMS, qui reçoivent votre adresse ou votre numéro le temps de vous transmettre le
              message, et rien d’autre.
            </li>
            <li>
              <strong>Le prestataire de paiement</strong> — si vous réglez en ligne. Vos données
              de carte sont saisies chez lui et <strong>n’atteignent jamais nos serveurs</strong> :
              nous n’en conservons qu’une référence opaque, qui ne permet ni de rejouer un
              paiement ni de reconstituer un numéro.
            </li>
          </ul>
          <p>Aucune donnée n’est vendue, échangée ou cédée à un tiers à des fins commerciales.</p>
        </section>

        <section className="spa-salon__section" aria-labelledby="conservation">
          <h2 className="spa-salon__section-title" id="conservation">
            Combien de temps, et vos droits
          </h2>
          <p>{BOOKING_CONSENT.rights}</p>
          <p>
            Une demande de suppression n’efface pas l’historique comptable des règlements déjà
            encaissés, que le commerçant est tenu de conserver : votre fiche est alors{' '}
            <strong>anonymisée</strong> — nom, coordonnées et notes retirés — et ce qui subsiste
            n’est plus rattachable à vous.
          </p>
          <p>
            Vous pouvez corriger vos coordonnées vous-même depuis{' '}
            <Link href={`${accountPath(tenantSlug)}/coordonnees`}>votre espace client</Link>. Pour
            un export ou une suppression, écrivez à l’établissement — il est votre interlocuteur
            et dispose des outils pour y répondre.
          </p>
        </section>

        <section className="spa-salon__section" aria-labelledby="retour">
          <h2 className="spa-salon__section-title" id="retour">
            Revenir au salon
          </h2>
          <ul className="spa-list">
            <li>
              <Link href={salonPath(tenantSlug)}>Les prestations de {tenantName}</Link>
            </li>
            <li>
              <Link href={reservationPath(tenantSlug)}>Prendre rendez-vous</Link>
            </li>
            <li>
              <Link href={accountPath(tenantSlug)}>Mon espace client</Link>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
