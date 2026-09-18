import { AppointmentSkeleton } from '../components/appointment-skeleton';

/**
 * L'onglet « Mes rendez-vous », le temps qu'il arrive (#830, #1053).
 *
 * ## Pourquoi sous `(liste)/` et non sur tout `compte/`
 *
 * Un squelette part avec l'en-tête de réponse, avant la page. Posé sur `compte/`,
 * il envelopperait aussi le report d'un rendez-vous, dont le `notFound()` doit
 * répondre 404 (`rendez-vous/[appointmentId]/report/not-found.tsx`) et ne
 * l'aurait plus pu. Le groupe ne change pas l'URL — la liste reste `/compte` —
 * et donne à l'onglet un dossier où poser son squelette sans envelopper ses
 * voisins.
 *
 * La forme est celle de l'écran qui arrive : une carte héros, puis des cartes
 * compactes (`components/appointment-skeleton.tsx`).
 */
export default function AccountLoading() {
  return <AppointmentSkeleton hero />;
}
