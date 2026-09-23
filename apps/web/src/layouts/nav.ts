import { Bell, Briefcase, Eye, FileText, LayoutDashboard, Landmark, Settings, Upload, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Primary navigation, in display order. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/intake', label: 'Intake', icon: Upload },
  { to: '/cases', label: 'Cases', icon: Briefcase },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/watchlist', label: 'Watchlist', icon: Eye },
  { to: '/vasps', label: 'VASP Registry', icon: Landmark },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** Route metadata read by the shell (title, breadcrumb parent) through react-router's `handle`. */
export interface RouteHandle {
  title: string;
  parent?: { label: string; to: string };
}
