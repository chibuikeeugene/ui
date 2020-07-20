import Vue from 'vue'
import VueApollo from 'vue-apollo'
import {
  createApolloClient,
  restartWebsockets
} from 'vue-cli-plugin-apollo/graphql-client'
import store from './store/index'
import { setContext } from 'apollo-link-context'
import LogRocket from 'logrocket'
// Install the vue plugin
Vue.use(VueApollo)

// Name of the localStorage item
const AUTH_TOKEN = 'authorization_token'

// Http endpoint
const httpEndpoint = process.env.VUE_APP_GRAPHQL_HTTP
// WS endpoint
// const wsEndpoint = process.env.VUE_APP_GRAPHQL_WS

// FIXME This is a hack, we'll have a better way to do this when we implement subscriptions
function checkIfOnlineUntilWeAre() {
  if (!navigator.onLine) {
    setTimeout(checkIfOnlineUntilWeAre.bind(this), 3000)
  } else {
    this.$apollo.skipAll = false
  }
}

function isExpired(expiry) {
  return new Date().getTime() > expiry
}

function notExpired(expiry) {
  return !isExpired(expiry)
}

function aboutToExpire(expiry) {
  return notExpired(expiry) && new Date().getTime() + 300000 >= expiry
}

const authMiddleware = setContext(async (_, { headers }) => {
  if (_.query && _.query.source && _.query.source == 'InteractiveAPI') {
    headers['X-Prefect-Interactive-API'] = true
  } else {
    headers['X-Prefect-UI'] = true
  }

  if (store.getters['api/backend'] === 'SERVER' || _.operationName == 'Api') {
    return {
      headers: {
        ...headers
      }
    }
  }

  const authRefreshRequired =
    store.getters['auth0/authorizationToken'] &&
    aboutToExpire(store.getters['auth0/authorizationTokenExpiry'])

  const validRefreshToken =
    store.getters['auth0/refreshToken'] &&
    notExpired(store.getters['auth0/refreshTokenExpiry'])

  const isAuthenticatedUser =
    store.getters['auth0/idToken'] &&
    notExpired(store.getters['auth0/idTokenExpiry'])

  const middleOfRefresh =
    store.getters['auth0/isRefreshingAuthorization'] ||
    store.getters['auth0/isAuthorizingUser'] ||
    store.getters['auth0/isLoggingInUser']

  if (
    store.getters['api/backend'] !== 'SERVER' &&
    (!store.getters['auth0/idToken'] || !isAuthenticatedUser) &&
    !store.getters['isRefreshingAuthentication']
  ) {
    return await store.dispatch('auth0/updateAuthentication')
  } else if (store.getters['isRefreshingAuthentication']) {
    // Don't fire requests while we're trying to refresh authentication
    return
  }

  if (_.operationName == 'RefreshToken') {
    // The refresh route requires the refresh token to be
    // sent as the authorization header, with the
    // access token as the body
    return {
      headers: {
        ...headers,
        authorization: `Bearer ${store.getters['auth0/refreshToken']}`
      }
    }
  }

  // The login route requires that no authorization header be sent
  if (_.operationName == 'LogIn') {
    return {
      headers: {
        ...headers
      }
    }
  }

  if (authRefreshRequired && !middleOfRefresh) {
    if (validRefreshToken) {
      await store.dispatch('auth0/refreshAuthorization')
    } else if (isAuthenticatedUser) {
      await store.dispatch('auth0/authorize')
    } else {
      await store.dispatch('auth0/login')
    }
  }

  const bearer = `Bearer ${store.getters['auth0/authorizationToken']}`
  return {
    headers: {
      ...headers,
      authorization: bearer
    }
  }
})

// Config
export const defaultOptions = {
  // You can use `https` for secure connection (recommended in production)
  httpEndpoint,
  // You can use `wss` for secure connection (recommended in production)
  // Use `null` to disable subscriptions
  wsEndpoint: null,
  //'ws://localhost:4300',
  // LocalStorage token
  tokenName: AUTH_TOKEN,
  // Enable Automatic Query persisting with Apollo Engine
  persisting: false,
  // Use websockets for everything (no HTTP)
  // You need to pass a `wsEndpoint` for this to work
  websocketsOnly: false,
  // Is being rendered on the server?
  ssr: false,

  // Override default apollo link
  // note: don't override httpLink here, specify httpLink options in the
  // httpLinkOptions property of defaultOptions.
  link: authMiddleware

  // Override default cache
  // cache: myCache

  // Override the way the Authorization header is set
  // getAuth: () => ...

  // Additional ApolloClient options
  // apollo: { ... }

  // Client local data (see apollo-link-state)
  // clientState: { resolvers: { ... }, defaults: { ... } }
}

// Create apollo client
export const createApolloProvider = () => {
  const { apolloClient, wsClient } = createApolloClient({
    ...defaultOptions
  })
  apolloClient.wsClient = wsClient

  // Create vue apollo provider
  const apolloProvider = new VueApollo({
    defaultClient: apolloClient,
    defaultOptions: {
      $query: {
        // fetchPolicy: 'cache-and-network',
        errorPolicy: 'all'
      },
      $subscription: {
        errorPolicy: 'all'
      }
    },
    async errorHandler(errors, vm, key, type, options) {
      const { graphQLErrors, networkError } = errors

      if (navigator && !navigator.onLine) {
        this.$apollo.skipAll = true
        setTimeout(checkIfOnlineUntilWeAre.bind(this), 3000)
      } else if (graphQLErrors?.length || networkError) {
        if (
          graphQLErrors?.[0].message == 'TokenExpiredError: jwt expired' &&
          !store.getters['auth0/isRefreshingAuthorization']
        ) {
          await store.dispatch('auth0/refreshAuthorization')
          this.$apollo.skipAll = true
        }
      } else {
        /* eslint-disable no-console */
        console.log(errors)
        console.log('graphQLErrors', graphQLErrors)
        console.log('networkError', networkError)
        console.log('vm', vm)
        console.log('key', key)
        console.log('type', type)
        console.log('options', options)
        LogRocket.captureException(graphQLErrors, networkError)
        LogRocket.log('Related to error', vm, key, type, options)
        /* eslint-enable no-console */
      }
    }
  })
  return apolloProvider
}

export async function apolloOnLogin(apolloClient) {
  if (apolloClient.wsClient) restartWebsockets(apolloClient.wsClient)
  await apolloClient.cache.reset()
}

export async function apolloOnLogout(apolloClient) {
  if (apolloClient.wsClient) restartWebsockets(apolloClient.wsClient)
  await apolloClient.cache.reset()
}
