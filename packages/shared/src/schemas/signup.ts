import { z } from 'zod';

import { passwordSchema } from '../common/identifiers';
import { accountDataConsentSchema } from './identity';
import { createTenantRequestSchema } from './platform';

/**
 * L'inscription d'un salon en libre-service : l'établissement, son gérant et le
 * mot de passe que celui-ci choisit.
 *
 * Mêmes champs que l'ouverture par la console (`createTenantRequestSchema`) —
 * c'est le même établissement —, plus ce que la console ne demande pas : le
 * mot de passe, puisque personne ne l'invite, et l'accord sur le traitement des
 * données, que le gérant donne lui-même (RGPD art. 7.1).
 */
export const salonSignupRequestSchema = createTenantRequestSchema.extend({
  password: passwordSchema,
  dataConsent: accountDataConsentSchema,
});

export type SalonSignupRequest = z.input<typeof salonSignupRequestSchema>;
