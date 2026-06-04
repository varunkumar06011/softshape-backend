/**
 * Captain name mapping
 * Centralized configuration for captain IDs to names
 * C1=Ajay Kumar, C2=Raja Behera, C3=Sagar, C4=Durga Prasad, C5=Subbaiah, C6=Happy
 */

export const CAPTAIN_NAMES: Record<string, string> = {
  'C1': 'Ajay Kumar',
  'C2': 'Raja Behera',
  'C3': 'Sagar',
  'C4': 'Durga Prasad',
  'C5': 'Subbaiah',
  'C6': 'Happy',
};

export const getCaptainName = (id?: string): string | undefined => {
  if (!id) return undefined;
  return CAPTAIN_NAMES[id] || undefined;
};
