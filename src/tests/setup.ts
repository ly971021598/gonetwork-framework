import { Engine } from '../state-channel'
import { serviceCreate, monitoring } from '../blockchain'
import { P2P } from '../p2p/p2p'

import { fakeStorage, CHAIN_ID } from '../utils'
import { Payload } from '../p2p/p2p-types'
import { readFromDisk as c } from './init-contracts'

import * as cfgBase from './config'

monitoring.setWaitForDefault({ timeout: 15 * 1000, interval: 250 })

export {
  monitoring
}

export const setupClient = (accountIndex: number, config?: Partial<typeof cfgBase>) => {
  const cfg = Object.assign({}, cfgBase, config)
  const account = cfg.accounts[accountIndex]
  if (!account) throw new Error('NO ACCOUNT FOUND')

  const p2p = new P2P({
    mqttUrl: cfg.mqttUrl,
    address: account.addressStr,
    storage: fakeStorage()
  })

  const [contracts, run] = c()

  const blockchain = serviceCreate({
    ...contracts,
    chainId: CHAIN_ID.GETH_PRIVATE_CHAINS,
    owner: account.address,
    signatureCb: (cb) => cb(account.privateKey),
    providerUrl: cfg.rpcUrl,
    monitoringInterval: cfg.monitoringInterval
  })

  const engine = new Engine({
    address: account.address,
    sign: (msg) => msg.sign(account.privateKey),
    send: (to, msg) => p2p.send(to.toString('hex'), msg as Payload),
    blockchain: blockchain
  })

  return { run, contracts, p2p, engine, blockchain, owner: account, txs: blockchain.txs }
}

export type Client = ReturnType<typeof setupClient>