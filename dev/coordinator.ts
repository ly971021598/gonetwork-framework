import * as http from 'http'
import * as qs from 'querystring'
import * as util from 'util'
import * as cp from 'child_process'

import * as qr from 'qrcode'
import * as wallet from 'ethereumjs-wallet'
import * as Web3 from 'Web3'

import { execIfScript } from './dev-utils'
import { Config } from './config'

(global as any).fetch = require('node-fetch')

const exec = util.promisify(cp.exec)

const etherAccount = '0x7582C707b9990a5BB3Ca23f8F7b61B6209829A6e'

const headersFn = (other?: http.OutgoingHttpHeaders) => Object.assign({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*'
}, other)

const response = (res: http.ServerResponse, body?: string, status = 200, headers: http.OutgoingHttpHeaders = headersFn()) => {
  res.writeHead(status, headers)
  res.end(body)
}

let id = 0
const ethRequest = (ethUrl: string, method: string, params = null as any) => fetch(ethUrl, {
  method: 'POST',
  headers: {
    contentType: 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: ++id,
    method: method,
    params
  })
})
  .then(res => res.status === 200 ?
    res.json().then((r: any) => {
      if (r.error) {
        return Promise.reject(r)
      }
      return r.result
    }) : Promise.reject(res))

const account = (ethUrl: string, w3: any) => {
  const wl = wallet.generate()
  const pk = `0x${wl.getPrivateKey().toString('hex')}`
  return ethRequest(ethUrl, 'personal_importRawKey', [pk, ''])
    .then(address => ({ privateKey: pk, address }))
    .then(acc => ethRequest(ethUrl, 'personal_unlockAccount', [acc.address, '', '0xFFFFFFFFF'])
      .then(() => w3.eth.sendTransaction({ from: etherAccount, to: acc.address, value: (Web3 as any).utils.toWei('1000', 'ether') }))
      .then(() => acc))
}

export const serve = (c: Config) => {
  const urls = {
    coordinator: `http://${c.hostname}:${c.coordinatorPort}`,
    eth: `http://${c.hostname}:${c.ethPort}`,
    mqtt: `ws://${c.hostname}:${c.mqttPort}`
  }

  const config = Object.assign({ urls }, c)

  const w3 = new (Web3 as any)(urls.eth)

  qr.toString(JSON.stringify(config), { type: 'terminal' }, (_: any, s: string) =>
    console.log(s))

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      response(res)
      return
    }

    const url = (req.url || '').substring(1).split('?')
    const [command, params] = [url[0], qs.parse(url[1])]

    console.log('REQ', command, params)

    switch (command) {
      case 'favicon.ico':
        return response(res)
      case 'config':
        return response(res, JSON.stringify(config))
      case 'account': {
        return account(urls.eth, w3)
          .then(acc => response(res, JSON.stringify(acc)))
          .catch(e => response(res, e, 400))
      }
      case 'account-with-contracts': {
        return account(urls.eth, w3)
          .then(account => {
            console.log(`node ${__dirname}/scripts/deploy-contracts.js ${urls.eth} ${account.address.substring(2)}`)
            exec(`node ${__dirname}/scripts/deploy-contracts.js ${urls.eth} ${account.address.substring(2)}`)
              .then(r => JSON.parse(r.stdout))
              .then(contracts => response(res, JSON.stringify({
                contracts,
                ...account
              })))
          }
          )
          .catch(e => {
            console.log('ERROR', e)
            response(res, e.stack, 400)
          })
      }

      default:
        response(res, '', 400)
    }
  })

  server.listen(c.coordinatorPort, c.hostname, () => console.log(`Coordinator listening on: ${urls.coordinator}`))

  return () => server.close()
}

execIfScript(serve, !module.parent)