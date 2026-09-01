import type { ReactNode } from 'react';

export type NotificationTone = 'info' | 'success' | 'warning' | 'danger';

interface NotificationProps {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly children?: ReactNode;
}

/**
 * Notification du design system (styles/README.md §2).
 *
 * `role` suit le ton : `alert` interrompt la lecture d'un lecteur d'écran,
 * `status` attend une pause. Un créneau perdu doit être annoncé tout de suite —
 * le visiteur est en train de cliquer ; une confirmation, non.
 */
export function Notification({ tone, title, children }: NotificationProps) {
  return (
    <div
      className={`spa-notification spa-notification--${tone}`}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      <div className="spa-notification__content">
        <p className="spa-notification__title">{title}</p>
        {children}
      </div>
    </div>
  );
}
