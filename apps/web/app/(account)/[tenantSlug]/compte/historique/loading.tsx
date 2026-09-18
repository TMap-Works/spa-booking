import { AppointmentSkeleton } from '../components/appointment-skeleton';

/**
 * L'onglet « Historique », le temps qu'il arrive (#1053, reformé par #1054).
 *
 * Sans carte héros : cet écran n'en a pas, et en peindre une ferait sauter la
 * mise en page à l'arrivée du contenu. Depuis #1054 il n'a pas non plus de
 * cartes — c'est une liste, coiffée d'une rangée de filtres —, et le squelette
 * prend la même forme, sous peine du même saut.
 *
 * Six lignes plutôt que quatre : la liste étant plus dense que les cartes
 * qu'elle remplace, c'est à peu près ce qu'un écran de téléphone en montre.
 *
 * Il est posé dans ce dossier et non sur `compte/` pour la même raison que celui
 * de `(liste)/` — voir son en-tête.
 */
export default function AccountHistoryLoading() {
  return <AppointmentSkeleton cards={6} shape="list" />;
}
