export interface Business {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  /** 'HH:mm' in the business timezone */
  opensAt: string;
  closesAt: string;
  /** ISO weekdays, 1 = Monday */
  workingDays: number[];
  slotIntervalMinutes: number;
  bookingHorizonDays: number;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  isActive: boolean;
}
