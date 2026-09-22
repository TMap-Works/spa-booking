import type AdminStaffMessages from './en/admin-staff.json';

/**
 * Le namespace `admin-staff` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre l'écran du personnel et la fiche d'un praticien : les comptes, les
 * fiches, les horaires hebdomadaires, les absences et les prestations
 * pratiquées.
 *
 * Même double lecture que `admin-planning` : `useTranslations('admin-staff')`
 * dans les composants, et l'import direct des deux JSON dans
 * `lib/admin/staff-messages.ts` pour les modules de calcul, qui n'ont pas de
 * crochet à leur disposition.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-staff': typeof AdminStaffMessages;
    }
  }
}

export {};
