export type AppointmentStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
export type AppointmentSource = 'chat' | 'form' | 'staff';
export type AppointmentScope = 'upcoming' | 'history';

export interface AppointmentDTO {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  notes: string | null;
  /** ISO-8601 UTC instants; clients format them in the business timezone. */
  startsAt: string;
  endsAt: string;
  createdAt: string;
  chatSessionId: string | null;
  service: { id: string; name: string; durationMinutes: number };
}

export interface CreateAppointmentInput {
  serviceId: string;
  /** 'YYYY-MM-DD' in the business timezone */
  date: string;
  /** 'HH:mm' in the business timezone */
  time: string;
  notes?: string | undefined;
  chatSessionId?: string | undefined;
  source: AppointmentSource;
}
