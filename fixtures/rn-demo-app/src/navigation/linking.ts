import { PROFILE_SCREEN } from './routeNames'

// Deliberately partial: Onboarding and the Tabs container have no URL, which is
// the normal state of a react-navigation linking config.
export const linking = {
  prefixes: ['rndemo://'],
  config: {
    screens: {
      Tabs: {
        screens: {
          Feed: 'feed',
          Search: 'search',
        },
      },
      Profile: 'profile/:userId',
      Settings: 'settings',
    },
  },
}
