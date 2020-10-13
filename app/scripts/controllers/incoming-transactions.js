import ObservableStore from 'obs-store'
import log from 'loglevel'
import BN from 'bn.js'
import createId from '../lib/random-id'
import { bnToHex } from '../lib/util'
import fetchWithTimeout from '../lib/fetch-with-timeout'

import {
  CHAIN_ID_TO_NETWORK_ID_MAP,
  CHAIN_ID_TO_TYPE_MAP,
  GOERLI,
  GOERLI_CHAIN_ID,
  KOVAN,
  KOVAN_CHAIN_ID,
  MAINNET,
  MAINNET_CHAIN_ID,
  RINKEBY,
  RINKEBY_CHAIN_ID,
  ROPSTEN,
  ROPSTEN_CHAIN_ID,
} from './network/enums'

const fetch = fetchWithTimeout({
  timeout: 30000,
})

export default class IncomingTransactionsController {

  constructor (opts = {}) {
    const {
      blockTracker,
      networkController,
      preferencesController,
    } = opts
    this.blockTracker = blockTracker
    this.networkController = networkController
    this.preferencesController = preferencesController

    this._onLatestBlock = async (newBlockNumberHex) => {
      const selectedAddress = this.preferencesController.getSelectedAddress()
      const newBlockNumberDec = parseInt(newBlockNumberHex, 16)
      await this._update({
        address: selectedAddress,
        newBlockNumberDec,
      })
    }

    const initState = {
      incomingTransactions: {},
      incomingTxLastFetchedBlocksByNetwork: {
        [GOERLI]: null,
        [KOVAN]: null,
        [MAINNET]: null,
        [RINKEBY]: null,
        [ROPSTEN]: null,
      }, ...opts.initState,
    }
    this.store = new ObservableStore(initState)

    this.preferencesController.store.subscribe(pairwise((prevState, currState) => {
      const { featureFlags: { showIncomingTransactions: prevShowIncomingTransactions } = {} } = prevState
      const { featureFlags: { showIncomingTransactions: currShowIncomingTransactions } = {} } = currState

      if (currShowIncomingTransactions === prevShowIncomingTransactions) {
        return
      }

      if (prevShowIncomingTransactions && !currShowIncomingTransactions) {
        this.stop()
        return
      }

      this.start()
    }))

    this.preferencesController.store.subscribe(pairwise(async (prevState, currState) => {
      const { selectedAddress: prevSelectedAddress } = prevState
      const { selectedAddress: currSelectedAddress } = currState

      if (currSelectedAddress === prevSelectedAddress) {
        return
      }

      await this._update({
        address: currSelectedAddress,
      })
    }))

    this.networkController.on('networkDidChange', async () => {
      const address = this.preferencesController.getSelectedAddress()
      await this._update({
        address,
      })
    })
  }

  start () {
    const { featureFlags = {} } = this.preferencesController.store.getState()
    const { showIncomingTransactions } = featureFlags

    if (!showIncomingTransactions) {
      return
    }

    this.blockTracker.removeListener('latest', this._onLatestBlock)
    this.blockTracker.addListener('latest', this._onLatestBlock)
  }

  stop () {
    this.blockTracker.removeListener('latest', this._onLatestBlock)
  }

  async _update ({ address, newBlockNumberDec } = {}) {
    try {
      const dataForUpdate = await this._getDataForUpdate({ address, newBlockNumberDec })
      await this._updateStateWithNewTxData(dataForUpdate)
    } catch (err) {
      log.error(err)
    }
  }

  async _getDataForUpdate ({ address, newBlockNumberDec } = {}) {
    const {
      incomingTransactions: currentIncomingTxs,
      incomingTxLastFetchedBlocksByNetwork: currentBlocksByNetwork,
    } = this.store.getState()

    const chainId = this.networkController.getCurrentChainId()
    const lastFetchBlockByCurrentNetwork = currentBlocksByNetwork[CHAIN_ID_TO_TYPE_MAP[chainId]]
    let blockToFetchFrom = lastFetchBlockByCurrentNetwork || newBlockNumberDec
    if (blockToFetchFrom === undefined) {
      blockToFetchFrom = parseInt(this.blockTracker.getCurrentBlock(), 16)
    }

    const { latestIncomingTxBlockNumber, txs: newTxs } = await this._fetchAll(address, blockToFetchFrom, chainId)

    return {
      latestIncomingTxBlockNumber,
      newTxs,
      currentIncomingTxs,
      currentBlocksByNetwork,
      fetchedBlockNumber: blockToFetchFrom,
      chainId,
    }
  }

  async _updateStateWithNewTxData ({
    latestIncomingTxBlockNumber,
    newTxs,
    currentIncomingTxs,
    currentBlocksByNetwork,
    fetchedBlockNumber,
    chainId,
  }) {
    const newLatestBlockHashByNetwork = latestIncomingTxBlockNumber
      ? parseInt(latestIncomingTxBlockNumber, 10) + 1
      : fetchedBlockNumber + 1
    const newIncomingTransactions = {
      ...currentIncomingTxs,
    }
    newTxs.forEach((tx) => {
      newIncomingTransactions[tx.hash] = tx
    })

    this.store.updateState({
      incomingTxLastFetchedBlocksByNetwork: {
        ...currentBlocksByNetwork,
        [CHAIN_ID_TO_TYPE_MAP[chainId]]: newLatestBlockHashByNetwork,
      },
      incomingTransactions: newIncomingTransactions,
    })
  }

  async _fetchAll (address, fromBlock, chainId) {
    const fetchedTxResponse = await this._fetchTxs(address, fromBlock, chainId)
    return this._processTxFetchResponse(fetchedTxResponse)
  }

  async _fetchTxs (address, fromBlock, chainId) {
    let etherscanSubdomain = 'api'

    if ([ROPSTEN_CHAIN_ID, RINKEBY_CHAIN_ID, GOERLI_CHAIN_ID, KOVAN_CHAIN_ID].includes(chainId)) {
      etherscanSubdomain = `api-${CHAIN_ID_TO_TYPE_MAP[chainId]}`
    } else if (chainId !== MAINNET_CHAIN_ID) {
      return {}
    }

    const apiUrl = `https://${etherscanSubdomain}.etherscan.io`
    let url = `${apiUrl}/api?module=account&action=txlist&address=${address}&tag=latest&page=1`

    if (fromBlock) {
      url += `&startBlock=${parseInt(fromBlock, 10)}`
    }
    const response = await fetch(url)
    const parsedResponse = await response.json()

    return {
      ...parsedResponse,
      address,
      chainId,
    }
  }

  _processTxFetchResponse ({ status, result = [], address, chainId }) {
    if (status === '1' && Array.isArray(result) && result.length > 0) {
      const remoteTxList = {}
      const remoteTxs = []
      result.forEach((tx) => {
        if (!remoteTxList[tx.hash]) {
          remoteTxs.push(this._normalizeTxFromEtherscan(tx, chainId))
          remoteTxList[tx.hash] = 1
        }
      })

      const incomingTxs = remoteTxs.filter((tx) => tx.txParams.to && tx.txParams.to.toLowerCase() === address.toLowerCase())
      incomingTxs.sort((a, b) => (a.time < b.time ? -1 : 1))

      let latestIncomingTxBlockNumber = null
      incomingTxs.forEach((tx) => {
        if (
          tx.blockNumber &&
          (!latestIncomingTxBlockNumber ||
            parseInt(latestIncomingTxBlockNumber, 10) < parseInt(tx.blockNumber, 10))
        ) {
          latestIncomingTxBlockNumber = tx.blockNumber
        }
      })
      return {
        latestIncomingTxBlockNumber,
        txs: incomingTxs,
      }
    }
    return {
      latestIncomingTxBlockNumber: null,
      txs: [],
    }
  }

  _normalizeTxFromEtherscan (txMeta, chainId) {
    const time = parseInt(txMeta.timeStamp, 10) * 1000
    const status = txMeta.isError === '0' ? 'confirmed' : 'failed'
    return {
      blockNumber: txMeta.blockNumber,
      id: createId(),
      metamaskNetworkId: CHAIN_ID_TO_NETWORK_ID_MAP[chainId],
      status,
      time,
      txParams: {
        from: txMeta.from,
        gas: bnToHex(new BN(txMeta.gas)),
        gasPrice: bnToHex(new BN(txMeta.gasPrice)),
        nonce: bnToHex(new BN(txMeta.nonce)),
        to: txMeta.to,
        value: bnToHex(new BN(txMeta.value)),
      },
      hash: txMeta.hash,
      transactionCategory: 'incoming',
    }
  }
}

function pairwise (fn) {
  let first = true
  let cache
  return (value) => {
    try {
      if (first) {
        first = false
        return fn(value, value)
      }
      return fn(cache, value)
    } finally {
      cache = value
    }
  }
}
