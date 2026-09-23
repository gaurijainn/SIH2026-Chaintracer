import type { Permission } from '@/lib/permissions';
import { Bell, Briefcase, Eye, FileText, LayoutDashboard, Landmark, Settings, Upload, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the role holds ANY of these (the backend matrix decides). Omitted = every signed-in user. */
  anyOf?: readonly Permission[];
}

/** Registering complaints is the only intake action, so Intake is for roles that can create them. */
export const INTAKE_ACCESS: readonly Permission[] = ['complaint:create'];
/** The API has no report-list permission; reports and freeze notices belong to roles that can generate or draft them. */
export const REPORT_ACCESS: readonly Permission[] = ['report:generate', 'notice:draft', 'notice:approve', 'notice:send'];

/** Primary navigation, in display order. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/intake', label: 'Intake', icon: Upload, anyOf: INTAKE_ACCESS },
  { to: '/cases', label: 'Cases', icon: Briefcase, anyOf: ['case:read'] },
  { to: '/alerts', label: 'Alerts', icon: Bell, anyOf: ['alert:read'] },
  { to: '/watchlist', label: 'Watchlist', icon: Eye, anyOf: ['watchlist:read'] },
  { to: '/vasps', label: 'VASP Registry', icon: Landmark, anyOf: ['vasp:read'] },
  { to: '/reports', label: 'Reports', icon: FileText, anyOf: REPORT_ACCESS },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** Route metadata read by the shell (title, breadcrumb parent) through react-router's `handle`. */
export interface RouteHandle {
  title: string;
  parent?: { label: string; to: string };
}
