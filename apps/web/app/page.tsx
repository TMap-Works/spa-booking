import { SUBSCRIPTION_PLAN } from '@spa/shared';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

import { BookingPreview } from '@/components/home/booking-preview';
import { SalonFinder } from '@/components/home/salon-finder';
import { Icon, type IconName } from '@/components/ui/icon';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { PHOTOS, type Photo } from '@/lib/photos';
import { PLAN_PRICE_LABEL, PLAN_PROMISE } from '@/lib/plan';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';
import { readSalonIdentity } from '@/lib/salon-identity';

import { salonPath } from './(account)/[tenantSlug]/compte/paths';
import { readLastSalon } from './last-salon';
import { SALON_DOORS, SALON_DOOR_LABELS, salonDoorPath } from './salon-doors';

/**
 * La page d'accueil de la plateforme — la racine du domaine (#927).
 *
 * ## Ce qu'elle remplace
 *
 * Un paragraphe : « chaque salon a sa propre page de réservation, suivez le lien
 * qu'il vous a communiqué ». Juste, mais sans issue — pour ouvrir quoi que ce
 * soit, il fallait taper une URL de la forme `/nom-du-salon/…`, y compris pour
 * l'équipe d'un salon qui cherchait son back-office.
 *
 * ## Ce qu'elle fait, et ce qu'elle s'interdit
 *
 * Elle présente le produit à ses deux publics — la clientèle qui réserve et
 * l'équipe qui accueille — par la boucle de valeur du CDC (§1.2) : réserver,
 * confirmer, honorer, encaisser, mesurer. Puis elle **ouvre le salon** qu'on lui
 * désigne, par la porte qu'on choisit (`SalonFinder`).
 *
 * Elle ne liste aucun salon — un annuaire est une place de marché, hors
 * périmètre (CDC §1.4). Depuis l'ADR 0016, elle propose en revanche **l'offre**
 * de la plateforme et l'inscription d'un salon en libre-service
 * (`/inscription`) : un essai gratuit, puis un abonnement mensuel. Chaque
 * promesse écrite ci-dessous correspond à une fonctionnalité livrée, et à rien
 * de plus.
 *
 * ## Le salon de la dernière visite
 *
 * Quand la personne a déjà ouvert un salon d'ici, un cookie en garde le slug
 * (`last-salon.ts`) et l'accueil lui en redonne les trois portes sans rien
 * ressaisir. Le nom est relu à l'API à chaque rendu ; si elle ne répond pas, le
 * raccourci s'efface et le slug préremplit simplement le champ — la page ne
 * dépend jamais de cet appel pour s'afficher.
 *
 * ## Server Component
 *
 * Tout ici est du contenu. Seul le formulaire est un Client Component, pour
 * garder la saisie et afficher son erreur sur le champ.
 */

export const metadata: Metadata = {
  title: `${PLATFORM_NAME} — la réservation en ligne des spas et salons`,
  description:
    'Réservation en ligne 24 h/24, confirmations et rappels automatiques, planning, encaissement et suivi de l’activité : tout le parcours d’un rendez-vous de spa ou de salon, au même endroit.',
};

/** Le cookie du dernier salon est propre à chaque visiteur : aucun rendu partagé. */
export const dynamic = 'force-dynamic';

interface Feature {
  readonly icon: IconName;
  readonly title: string;
  readonly text: string;
}

const PROOFS: readonly string[] = [
  'Réservation en ligne, jour et nuit',
  'Confirmation immédiate, rappel la veille',
  'Aucun créneau réservé deux fois',
];

const TRUST: readonly Feature[] = [
  {
    icon: 'clock',
    title: 'Ouvert 24 h/24',
    text: 'Les créneaux libres se réservent à toute heure, au fuseau du salon.',
  },
  {
    icon: 'bell',
    title: 'Rappels automatiques',
    text: 'Une confirmation tout de suite, un rappel 24 h avant, par e-mail ou SMS.',
  },
  {
    icon: 'lock',
    title: 'Paiement sécurisé',
    text: 'Confié à Stripe : aucune donnée de carte ne passe par nos serveurs.',
  },
  {
    icon: 'shield',
    title: 'Zéro double réservation',
    text: 'Un créneau pris est verrouillé à l’instant même, pour tout le monde.',
  },
];

/**
 * Les quatre métiers du périmètre, illustrés — CDC §1.1.
 *
 * La surcapitale du héros les énumère depuis #927 (« Spas · instituts ·
 * coiffure · barbiers · massage ») sans que rien ne les montre : une gérante de
 * barbershop lisait une page qui ne ressemblait qu'à un spa. Cette bande est la
 * seule de l'accueil dont le propos soit l'image ; le libellé n'y est qu'une
 * légende, et c'est pourquoi il tient en deux mots.
 *
 * Les photographies sont **informatives** ici, et non décoratives comme dans
 * les volets d'identification : elles sont le contenu de la section. Elles
 * portent donc l'`alt` du registre (`lib/photos.ts`) plutôt qu'un
 * `aria-hidden`.
 */
const TRADES: readonly { readonly label: string; readonly photo: Photo }[] = [
  { label: 'Spas', photo: PHOTOS.spaInterieur },
  { label: 'Instituts de beauté', photo: PHOTOS.soinVisage },
  { label: 'Salons de coiffure', photo: PHOTOS.salonInterieur },
  { label: 'Barbershops', photo: PHOTOS.barbier },
];

const LOOP: readonly Feature[] = [
  {
    icon: 'calendar',
    title: 'Réserver',
    text: 'La cliente choisit sa prestation, son praticien — ou le premier disponible — et un créneau libre en temps réel.',
  },
  {
    icon: 'bell',
    title: 'Confirmer',
    text: 'La confirmation part aussitôt, le rappel la veille. Un report ou une annulation prévient le salon comme la cliente.',
  },
  {
    icon: 'users',
    title: 'Honorer',
    text: 'L’équipe suit sa journée sur le planning, retrouve la fiche de chaque cliente et marque les absences.',
  },
  {
    icon: 'card',
    title: 'Encaisser',
    text: 'Au comptoir, par carte ou en espèces, prestations et produits compris, avec son ticket de caisse.',
  },
  {
    icon: 'chart',
    title: 'Mesurer',
    text: 'Le revenu du jour, le volume de rendez-vous et les no-shows, sans tableur.',
  },
];

const FOR_CLIENTS: readonly string[] = [
  'Les prestations, leur durée et leur prix, avant de choisir',
  'Le praticien de votre choix, ou le premier disponible',
  'Une réservation sans compte, en quelques secondes',
  'Vos rendez-vous à venir et passés, dans votre espace',
  'Un report ou une annulation en ligne, sans appeler',
];

const FOR_TEAMS: readonly string[] = [
  'Le planning du jour et de la semaine, rendez-vous du comptoir compris',
  'Les fiches clientes : coordonnées, notes et historique des visites',
  'Les comptes de l’équipe, leurs rôles, horaires et absences',
  'L’encaissement par carte ou en espèces, et l’historique des ventes',
  'Le revenu, le volume de rendez-vous et les no-shows',
];

const STEPS: readonly { readonly title: string; readonly text: string }[] = [
  {
    title: 'Choisissez votre prestation',
    text: 'Le catalogue du salon affiche la durée et le prix de chaque soin.',
  },
  {
    title: 'Choisissez votre créneau',
    text: 'Avec le praticien de votre choix, parmi les horaires réellement libres.',
  },
  {
    title: 'C’est confirmé',
    text: 'Vous recevez la confirmation tout de suite, et un rappel la veille.',
  },
];

/** L'inscription d'un salon en libre-service (ADR 0016). */
const SIGNUP_PATH = '/inscription';

/** Ce que comprend l'offre unique — chaque ligne est une fonctionnalité livrée. */
const PLAN_INCLUDES: readonly string[] = [
  'Votre page de réservation en ligne, ouverte 24 h/24',
  'Confirmations et rappels automatiques',
  'Planning jour et semaine, équipe et horaires',
  'Fiches clientes, notes et historique des visites',
  'Encaissement au comptoir et reçus',
  'Revenu, rendez-vous et absences en un coup d’œil',
];

const QUESTIONS: readonly { readonly question: string; readonly answer: string }[] = [
  {
    question: 'Je ne connais pas l’adresse de mon salon.',
    answer:
      'Saisissez simplement son nom ci-dessus. Le lien exact figure aussi dans l’e-mail de confirmation de votre dernier rendez-vous, et le salon peut vous le transmettre.',
  },
  {
    question: 'Faut-il créer un compte pour réserver ?',
    answer:
      'Non : vos coordonnées suffisent. Un compte vous permet ensuite de retrouver tous vos rendez-vous, et de les reporter ou de les annuler en ligne.',
  },
  {
    question: 'Comment reporter ou annuler un rendez-vous ?',
    // La porte est nommée par le registre et non recopiée : cette réponse
    // désigne le bouton qui se trouve juste au-dessus, et deux libellés écrits
    // séparément finissent par diverger — c'est l'écart que #749 a fermé.
    answer: `Depuis « ${SALON_DOOR_LABELS.compte} », dans l’espace client de votre salon, tant que le délai fixé par le salon le permet. Le salon est prévenu automatiquement.`,
  },
  {
    question: 'Mes données de carte bancaire sont-elles conservées ?',
    answer:
      'Non. Le paiement est confié à Stripe : les données de votre carte vont directement de votre navigateur à Stripe, sans jamais passer par nos serveurs.',
  },
  {
    question: 'Combien coûte la plateforme pour un salon ?',
    answer: `${PLAN_PROMISE}, sans engagement. Votre carte est enregistrée par Stripe à l’inscription et n’est débitée qu’à la fin de l’essai ; vous résiliez quand vous voulez depuis votre back-office.`,
  },
  {
    question: 'Je travaille dans un salon : comment me connecter ?',
    answer:
      'Indiquez le salon ci-dessus puis choisissez « Back-office du salon ». Vos identifiants vous sont remis par la gérance du salon.',
  },
];

/** Le salon de la dernière visite, avec son nom — ou ce qu'il reste à préremplir. */
async function rememberedSalon(): Promise<{
  readonly salon: { readonly slug: string; readonly name: string } | null;
  readonly prefill: string;
}> {
  const slug = await readLastSalon();

  if (slug === null) {
    return { salon: null, prefill: '' };
  }

  const identity = await readSalonIdentity(slug);

  if (identity.status === 'found') {
    return { salon: { slug: identity.slug, name: identity.name }, prefill: '' };
  }

  // Un salon disparu n'a rien à préremplir ; une API muette, si.
  return { salon: null, prefill: identity.status === 'unavailable' ? slug : '' };
}

export default async function HomePage() {
  const { salon, prefill } = await rememberedSalon();

  return (
    <div className="spa-home">
      <header className="spa-home-bar">
        <div className="spa-home-bar__inner">
          <Link className="spa-home-bar__brand" href={PLATFORM_HOME_PATH}>
            <span className="spa-home-bar__mark" aria-hidden="true">
              <Icon name="leaf" />
            </span>
            <span className="spa-home-bar__name">{PLATFORM_NAME}</span>
          </Link>
          <nav className="spa-home-bar__nav" aria-label="Sections de la page">
            <a className="spa-home-bar__link" href="#parcours">
              Fonctionnalités
            </a>
            <a className="spa-home-bar__link" href="#reserver">
              Comment ça marche
            </a>
            <a className="spa-home-bar__link" href="#tarifs">
              Tarifs
            </a>
            <a className="spa-home-bar__link" href="#questions">
              Questions
            </a>
            <a className="spa-home-bar__link spa-home-bar__link--access" href="#acces">
              Accéder à mon salon
            </a>
            <Link className="spa-home-bar__cta" href={SIGNUP_PATH}>
              Essai gratuit
            </Link>
          </nav>
        </div>
      </header>

      <main id="contenu">
        <section className="spa-home-hero" aria-labelledby="accueil-titre">
          <div className="spa-home__inner spa-home-hero__inner">
            <div className="spa-home-hero__copy">
              <p className="spa-home__eyebrow">Spas · instituts · coiffure · barbiers · massage</p>
              <h1 className="spa-home-hero__title" id="accueil-titre">
                Des rendez-vous qui font du bien,{' '}
                <span className="spa-home-hero__title-accent">
                  de la réservation à l’encaissement.
                </span>
              </h1>
              <p className="spa-home-hero__lead">
                Vos clientes réservent en quelques secondes, à toute heure. Votre équipe retrouve
                son planning, ses fiches clientes, sa caisse et ses chiffres au même endroit.
              </p>
              <ul className="spa-home-hero__proofs">
                {PROOFS.map((proof) => (
                  <li className="spa-home-hero__proof" key={proof}>
                    <Icon name="check" className="spa-home-hero__proof-icon" />
                    {proof}
                  </li>
                ))}
              </ul>
            </div>

            <div className="spa-home-hero__access" id="acces">
              {salon === null ? null : (
                <section className="spa-home-return" aria-labelledby="retour-titre">
                  <p className="spa-home-return__eyebrow">
                    <Icon name="store" className="spa-home-return__eyebrow-icon" />
                    Votre salon
                  </p>
                  <h2 className="spa-home-return__name" id="retour-titre">
                    <Link href={salonPath(salon.slug)}>{salon.name}</Link>
                  </h2>
                  <ul className="spa-home-return__doors">
                    {SALON_DOORS.map((door) => (
                      <li key={door}>
                        <Link className="spa-home-return__door" href={salonDoorPath(salon.slug, door)}>
                          {SALON_DOOR_LABELS[door]}
                          <Icon name="arrow" className="spa-home-return__door-icon" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <SalonFinder
                initialAddress={prefill}
                title={salon === null ? 'Accéder à mon salon' : 'Un autre salon ?'}
              />
            </div>
          </div>
        </section>

        <section className="spa-home-trust" aria-label="Nos engagements">
          <ul className="spa-home__inner spa-home-trust__list">
            {TRUST.map((item) => (
              <li className="spa-home-trust__item" key={item.title}>
                <span className="spa-home__badge">
                  <Icon name={item.icon} />
                </span>
                <p className="spa-home-trust__text">
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="spa-home-trades" aria-labelledby="metiers-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">Pour qui c’est fait</p>
              <h2 className="spa-home-section__title" id="metiers-titre">
                Tous les métiers du rendez-vous
              </h2>
              <p className="spa-home-section__lead">
                Une prestation, une durée, un praticien, un créneau : la même mécanique sert un
                soin du visage comme une coupe de barbe.
              </p>
            </div>
            <ul className="spa-home-trades__list">
              {TRADES.map((trade) => (
                <li className="spa-home-trades__item" key={trade.label}>
                  {/*
                    `sizes` décrit la place réellement occupée, sinon Next sert
                    l'image pleine largeur de l'écran pour une vignette de
                    quatre colonnes. Les paliers suivent ceux de la grille
                    ci-contre, dans `home.css`.
                  */}
                  <Image
                    className="spa-home-trades__photo"
                    src={trade.photo.src}
                    alt={trade.photo.alt}
                    width={trade.photo.width}
                    height={trade.photo.height}
                    sizes="(min-width: 60rem) 25vw, (min-width: 40rem) 50vw, 100vw"
                  />
                  <span className="spa-home-trades__label">{trade.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="spa-home-section" id="parcours" aria-labelledby="parcours-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">Fonctionnalités</p>
              <h2 className="spa-home-section__title" id="parcours-titre">
                Tout le parcours d’un rendez-vous, au même endroit
              </h2>
              <p className="spa-home-section__lead">
                De la réservation au bilan de la journée, chaque étape passe la main à la suivante
                sans ressaisie.
              </p>
            </div>
            {/* `role="list"` explicite : le socle retire le marqueur de tout `<ol>`,
                et Safari retire alors la sémantique de liste à VoiceOver — or
                l'ordre des cinq étapes est le propos (styles/README.md §3). */}
            <ol className="spa-home-loop" role="list">
              {LOOP.map((step, index) => (
                <li className="spa-home-loop__step" key={step.title}>
                  <div className="spa-home-loop__top">
                    <span className="spa-home__badge">
                      <Icon name={step.icon} />
                    </span>
                    <span className="spa-home-loop__index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <h3 className="spa-home-loop__title">{step.title}</h3>
                  <p className="spa-home-loop__text">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="spa-home-section spa-home-section--sunken" aria-labelledby="publics-titre">
          <div className="spa-home__inner">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">Pour qui</p>
              <h2 className="spa-home-section__title" id="publics-titre">
                Pensé pour la clientèle comme pour l’équipe du salon
              </h2>
            </div>
            <div className="spa-home-audiences">
              <article className="spa-home-audience" aria-labelledby="clientele-titre">
                {/*
                  Pas `massageDos` ici, bien qu'elle soit la scène la plus
                  juste pour une cliente : c'est un portrait (1100 × 1650) dont
                  le centre est un drap blanc, et le recadrage en 16/9 de ce
                  bandeau n'en garde qu'un aplat clair — une carte qui paraît
                  n'avoir pas chargé son image. Elle sert le volet vertical de
                  la connexion cliente, où sa hauteur est un avantage.
                */}
                <Image
                  className="spa-home-audience__photo"
                  src={PHOTOS.natureMorteSpa.src}
                  alt={PHOTOS.natureMorteSpa.alt}
                  width={PHOTOS.natureMorteSpa.width}
                  height={PHOTOS.natureMorteSpa.height}
                  sizes="(min-width: 48rem) 50vw, 100vw"
                />
                <span className="spa-home__badge">
                  <Icon name="sparkle" />
                </span>
                <h3 className="spa-home-audience__title" id="clientele-titre">
                  Pour la clientèle
                </h3>
                <ul className="spa-home-audience__list">
                  {FOR_CLIENTS.map((item) => (
                    <li className="spa-home-audience__item" key={item}>
                      <Icon name="check" className="spa-home-audience__check" />
                      {item}
                    </li>
                  ))}
                </ul>
                <a className="spa-home-audience__link" href="#acces">
                  Trouver mon salon
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </a>
              </article>
              <article
                className="spa-home-audience spa-home-audience--brand"
                aria-labelledby="equipe-titre"
              >
                <Image
                  className="spa-home-audience__photo"
                  src={PHOTOS.coiffureBrushing.src}
                  alt={PHOTOS.coiffureBrushing.alt}
                  width={PHOTOS.coiffureBrushing.width}
                  height={PHOTOS.coiffureBrushing.height}
                  sizes="(min-width: 48rem) 50vw, 100vw"
                />
                <span className="spa-home__badge spa-home__badge--brand">
                  <Icon name="store" />
                </span>
                <h3 className="spa-home-audience__title" id="equipe-titre">
                  Pour l’équipe du salon
                </h3>
                <ul className="spa-home-audience__list">
                  {FOR_TEAMS.map((item) => (
                    <li className="spa-home-audience__item" key={item}>
                      <Icon name="check" className="spa-home-audience__check" />
                      {item}
                    </li>
                  ))}
                </ul>
                <a className="spa-home-audience__link" href="#acces">
                  Ouvrir le back-office
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </a>
                <Link className="spa-home-audience__link" href={SIGNUP_PATH}>
                  Pas encore inscrit ? Créer mon salon
                  <Icon name="arrow" className="spa-home-audience__link-icon" />
                </Link>
              </article>
            </div>
          </div>
        </section>

        <section className="spa-home-section" id="reserver" aria-labelledby="reserver-titre">
          <div className="spa-home__inner spa-home-steps">
            <div className="spa-home-steps__copy">
              <div className="spa-home-section__heading">
                <p className="spa-home__eyebrow">Comment ça marche</p>
                <h2 className="spa-home-section__title" id="reserver-titre">
                  Réserver en trois gestes
                </h2>
              </div>
              {/* Même raison : les trois gestes se font dans cet ordre. */}
              <ol className="spa-home-steps__list" role="list">
                {STEPS.map((step, index) => (
                  <li className="spa-home-steps__item" key={step.title}>
                    <span className="spa-home-steps__number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="spa-home-steps__title">{step.title}</h3>
                      <p className="spa-home-steps__text">{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <BookingPreview />
          </div>
        </section>

        <section className="spa-home-section" id="tarifs" aria-labelledby="tarifs-titre">
          <div className="spa-home__inner spa-home-pricing">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">Tarifs</p>
              <h2 className="spa-home-section__title" id="tarifs-titre">
                Une offre, tout compris
              </h2>
            </div>
            <article className="spa-home-pricing__card" aria-labelledby="offre-titre">
              <h3 className="spa-home-pricing__name" id="offre-titre">
                {SUBSCRIPTION_PLAN.name}
              </h3>
              <p className="spa-home-pricing__price">
                <span className="spa-home-pricing__amount">{PLAN_PRICE_LABEL}</span>
                <span className="spa-home-pricing__period">par mois, sans engagement</span>
              </p>
              <p className="spa-home-pricing__trial">
                {SUBSCRIPTION_PLAN.trialDays} jours d’essai gratuit — la carte n’est débitée qu’à la
                fin de l’essai.
              </p>
              <ul className="spa-home-pricing__list">
                {PLAN_INCLUDES.map((item) => (
                  <li className="spa-home-pricing__item" key={item}>
                    <Icon name="check" className="spa-home-pricing__check" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link className="spa-home-pricing__cta" href={SIGNUP_PATH}>
                Démarrer mon essai gratuit
                <Icon name="arrow" className="spa-home-pricing__cta-icon" />
              </Link>
            </article>
          </div>
        </section>

        <section
          className="spa-home-section spa-home-section--sunken"
          id="questions"
          aria-labelledby="questions-titre"
        >
          <div className="spa-home__inner spa-home-faq">
            <div className="spa-home-section__heading">
              <p className="spa-home__eyebrow">Questions fréquentes</p>
              <h2 className="spa-home-section__title" id="questions-titre">
                Bon à savoir
              </h2>
            </div>
            <div className="spa-home-faq__list">
              {QUESTIONS.map((item) => (
                <details className="spa-home-faq__item" key={item.question}>
                  <summary className="spa-home-faq__question">{item.question}</summary>
                  <p className="spa-home-faq__answer">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="spa-home-closing" aria-labelledby="fin-titre">
          <div className="spa-home__inner spa-home-closing__inner">
            <h2 className="spa-home-closing__title" id="fin-titre">
              Votre prochain rendez-vous commence ici.
            </h2>
            <a className="spa-home-closing__link" href="#acces">
              Accéder à mon salon
              <Icon name="arrow" className="spa-home-closing__link-icon" />
            </a>
            <Link className="spa-home-closing__link" href={SIGNUP_PATH}>
              Ouvrir mon salon — {SUBSCRIPTION_PLAN.trialDays} jours gratuits
              <Icon name="arrow" className="spa-home-closing__link-icon" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="spa-home-footer">
        <div className="spa-home__inner spa-home-footer__inner">
          <p className="spa-home-footer__brand">{PLATFORM_NAME}</p>
          <p className="spa-home-footer__text">
            La réservation en ligne des spas, instituts, salons de coiffure, barbiers et studios de
            massage.
          </p>
          {/* Le sélecteur de thème du back-office, sur le même cookie (#1114).
              Dans le pied et non dans la barre : même à 1280 px, ses trois
              pastilles faisaient passer la marque et deux ancres sur deux
              lignes. */}
          <ThemeToggle className="spa-home-footer__theme" />
        </div>
      </footer>
    </div>
  );
}
