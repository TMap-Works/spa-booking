export {
  APPOINTMENT_STATUS_TRANSITIONS,
  APPOINTMENT_STATUSES,
  BLOCKING_APPOINTMENT_STATUSES,
  CANCELLATION_ACTORS,
  TERMINAL_APPOINTMENT_STATUSES,
  canTransitionAppointment,
  isAppointmentStatus,
  isBlockingAppointmentStatus,
} from './appointment';
export type { AppointmentStatus, CancellationActor } from './appointment';

export {
  ADDRESS_LINE_MAX_LENGTH,
  CITY_MAX_LENGTH,
  DEFAULT_MIN_BOOKING_NOTICE_MINUTES,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_ADDRESS_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  MAX_AVAILABILITY_RANGE_DAYS,
  MAX_MIN_BOOKING_NOTICE_MINUTES,
  MAX_OPENING_HOURS_ENTRIES,
  MAX_PAGE_SIZE,
  MAX_SLOT_INTERVAL_MINUTES,
  MAX_TIME_OFF_RANGE_DAYS,
  MIN_BOOKING_NOTICE_MINUTES_FLOOR,
  MIN_SLOT_INTERVAL_MINUTES,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  TIMEZONE_MAX_LENGTH,
} from './limits';

export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  isNotificationChannel,
} from './notification';
export type { NotificationChannel, NotificationStatus, NotificationType } from './notification';

export {
  CAPTURED_PAYMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  isPaymentStatus,
} from './payment';
export type { PaymentMethod, PaymentStatus } from './payment';

export {
  STAFF_ROLES,
  USER_ROLE_RANK,
  USER_ROLES,
  hasAtLeastRole,
  isStaffRole,
  isUserRole,
} from './roles';
export type { StaffRole, UserRole } from './roles';
