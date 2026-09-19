export type FormHistoryCandidate = { fixtureId: string; team: string; country: string; league: string; kickoffUtc?: string };
type LeagueGroup<T> = { league: string; candidates: T[] };
export type CountryGroup<T> = { country: string; flag: string; candidateCount: number; leagues: LeagueGroup<T>[] };

const majorCountryOrder = ['england', 'spain', 'germany', 'italy', 'france'];
const flags: Record<string, string> = {
  albania: '🇦🇱', algeria: '🇩🇿', argentina: '🇦🇷', armenia: '🇦🇲', austria: '🇦🇹', belgium: '🇧🇪', brazil: '🇧🇷', bulgaria: '🇧🇬', chile: '🇨🇱', china: '🇨🇳', colombia: '🇨🇴', croatia: '🇭🇷', cyprus: '🇨🇾', czechia: '🇨🇿', 'czech republic': '🇨🇿', denmark: '🇩🇰', ecuador: '🇪🇨', egypt: '🇪🇬', england: '🇬🇧', estonia: '🇪🇪', finland: '🇫🇮', france: '🇫🇷', germany: '🇩🇪', greece: '🇬🇷', hungary: '🇭🇺', iran: '🇮🇷', ireland: '🇮🇪', italy: '🇮🇹', japan: '🇯🇵', latvia: '🇱🇻', mexico: '🇲🇽', netherlands: '🇳🇱', norway: '🇳🇴', 'northern ireland': '🇬🇧', paraguay: '🇵🇾', peru: '🇵🇪', poland: '🇵🇱', portugal: '🇵🇹', qatar: '🇶🇦', romania: '🇷🇴', 'saudi arabia': '🇸🇦', scotland: '🏴', serbia: '🇷🇸', slovakia: '🇸🇰', slovenia: '🇸🇮', spain: '🇪🇸', sweden: '🇸🇪', switzerland: '🇨🇭', thailand: '🇹🇭', turkey: '🇹🇷', türkiye: '🇹🇷', turkiye: '🇹🇷', ukraine: '🇺🇦', 'united arab emirates': '🇦🇪', uae: '🇦🇪', usa: '🇺🇸', 'united states': '🇺🇸', venezuela: '🇻🇪', wales: '🏴', world: '🌐', international: '🌐',
};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : 'Unknown';
const key = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en');
const compare = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

export function countryFlag(country: string) { return flags[key(text(country))] ?? '🏳️'; }

export function groupFormCandidates<T extends FormHistoryCandidate>(items: readonly T[]): CountryGroup<T>[] {
  const countries = new Map<string, Map<string, T[]>>();
  for (const item of items) {
    const country = text(item.country), league = text(item.league);
    const leagues = countries.get(country) ?? new Map<string, T[]>();
    leagues.set(league, [...(leagues.get(league) ?? []), item]);
    countries.set(country, leagues);
  }
  return [...countries.entries()].sort(([a], [b]) => {
    const ai = majorCountryOrder.indexOf(key(a)), bi = majorCountryOrder.indexOf(key(b));
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return compare(a, b);
  }).map(([country, leagues]) => {
    const orderedLeagues = [...leagues.entries()].sort(([a], [b]) => compare(a, b)).map(([league, candidates]) => ({ league, candidates: [...candidates].sort((a, b) => Date.parse(a.kickoffUtc ?? '') - Date.parse(b.kickoffUtc ?? '') || compare(a.team, b.team)) }));
    return { country, flag: countryFlag(country), candidateCount: orderedLeagues.reduce((sum, league) => sum + league.candidates.length, 0), leagues: orderedLeagues };
  });
}
