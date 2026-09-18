import { AppointmentSkeleton } from '../components/appointment-skeleton';

/**
 * L'onglet « Historique », le temps qu'il arrive (#1053).
 *
 * Même squelette que l'onglet voisin, sans carte héros : cet écran n'en a pas,
 * et en peindre une ferait sauter la mise en page à l'arrivée du contenu. Il est
 * posé dans ce dossier et non sur `compte/` pour la même raison que celui de
 * `(liste)/` — voir son en-tête.
 */
export default function AccountHistoryLoading() {
  return <AppointmentSkeleton cards={4} />;
}
