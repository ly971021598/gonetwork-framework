import { Observable } from 'rxjs/Observable'
import { Subject } from 'rxjs/Subject'
import { BehaviorSubject } from 'rxjs/BehaviorSubject'
import { EventEmitter } from 'events'

import * as util from 'ethereumjs-util'
import * as BN from 'bn.js'

import { decode } from './log-decoder'

import * as T from '../types'

// todo: make it configurable
const KEY_PREFIX = '___ETH_MONITORING___'
const LOGS_INTERVAL = 5 * 1000
const TRANSACTION_INTERVAL = 5 * 1000

export type MonitorAddress = [T.EthAddress, string]

export interface State {
  addresses: MonitorAddress[],
  transactions: T.EthAddress[]
}

export class Monitoring implements T.EthMonitoring {
  private _cfg: T.EthMonitoringConfig
  private _em = new EventEmitter()
  private _state: Promise<State>
  private _sub: any
  private _transactions: Subject<T.EthTransaction> = new Subject()
  private _blockNumberSub = new BehaviorSubject<util.BN | undefined>(undefined)
  private _forceMonitoring = new Subject<boolean>()
  private _toSubscribe: T.EthAddress[] = []

  constructor (cfg: T.EthMonitoringConfig) {
    this._cfg = cfg
    this._state = cfg.storage.getItem(KEY_PREFIX + cfg.channelManagerAddress)
      .then(s => s ? JSON.parse(s) : ({
        addresses: [
          [cfg.channelManagerAddress, '-1'],
          ...cfg.tokenAddresses.map(t => [t, '-1'])
        ],
        transactions: []
      }))
      .then(s => {
        console.log('STATE', s)
        return s
      })

    this._sub =
      this._monitorAddresses()
        .merge(
          this._monitorBlockNumber(),
          this._monitorTransactions()
        )
        .subscribe()
  }

  subscribeAddress = (a: T.EthAddress) =>
    this._state.then(s => {
      if (s.addresses.find(_a => _a[0] === a)) return Promise.resolve(false)
      s.addresses.push([a, '-1'])
      this._forceMonitoring.next(true)
      return this._saveState(s)
    })

  unsubscribeAddress = (a: T.EthAddress) => {
    if (a === this._cfg.channelManagerAddress) return Promise.resolve(false)
    return this._state.then(s => {
      s.addresses = s.addresses.filter(_a => _a[0] === a)
      return this._saveState(s)
    })
  }

  transactionReceiptWithPersistance = (tx) => {
    return this._state.then(s => {
      if (s.transactions.find(tx)) {
        return false
      }
      s.transactions.push(tx)
      return this._saveState(s)
        .then(() => this._transactions.next(tx))
        .then(() => true)
    })
  }

  transactionReceipt = (tx) =>
    Observable.timer(0, TRANSACTION_INTERVAL)
      .switchMap(() =>
        Observable.defer(() => this._cfg.getTransactionReceipt(tx))
          .catch((err) => {
            console.log('TRANSACTION_MONITORING_ERROR', err)
            return Observable.empty()
          })
      )
      .take(1)
      .toPromise()

  on (event: T.BlockchainEventType, listener: (...args: any[]) => void) {
    this._em.on(event, listener)
  }

  off (event: T.BlockchainEventType, listener: (...args: any[]) => void) {
    this._em.removeListener(event, listener)
  }

  dispose = () => this._sub && this._sub.unsubscribe()

  private _blockNumber = () => this._blockNumberSub.value

  private _monitorBlockNumber = () =>
    Observable.timer(0, LOGS_INTERVAL)
      .switchMap(() =>
        Observable.defer(() => this._cfg.blockNumber())
          .retryWhen(errs => errs.delay(1000))
      )
      .do(x => x !== this._blockNumber() && this._blockNumberSub.next(x))

  private _monitorAddresses = () =>
    (Observable.combineLatest(
      this._blockNumberSub,
      this._forceMonitoring.merge(Observable.of(true)),
      n => n
    )
      // .do(x => console.log('BN-SUBJECT', x))
      .filter(x => x !== undefined) as Observable<T.EthBlockNumber>)
      .do(bn => console.log('MONITORING -- BLOCK:', bn))
      .exhaustMap(blockNumber =>
        Observable.defer(() => this._state)
          .mergeMap((s: State) =>
            Observable.from(s.addresses)
              .groupBy(a => a[1])
              .do(xs => console.log('BY-LAST-BLOCK', xs.key))
              .mergeMap(xs => xs
                .map(x => x[0])
                .reduce((acc, x) => acc.concat([x]), [])
                .mergeMap(gs =>
                  Observable.defer(() => {
                    const bn = new util.BN(xs.key)
                    if (bn.lt(blockNumber)) {
                      return this._cfg.getLogs(bn.add(new util.BN(1)), blockNumber, gs)
                    } else {
                      return Observable.of([] as T.BlockchainEvent[])
                    }
                  })
                    // .do(x => console.log('LOGS', x))
                    .map(logs => logs.map(decode))
                    .reduce((acc, logs) => ({
                      logs: acc.logs.concat(logs),
                      addresses: acc.addresses.concat(gs)
                    }), { logs: [] as any, addresses: [] as T.EthAddress[] })
                ))
              .do(x => x.logs.length && console.log('BLOCK:', blockNumber, ' -- NEW_EVENTS_COUNT:', x.logs.length, ' ADDRESSES COUNT: ', s.addresses.length))
              // .do(x => console.log('NEW_EVENTS', x.logs))
              .do(({ logs }) => logs.forEach(l => this._em.emit(l._type, l)))
              .mergeMap(({ addresses }) => {
                addresses.forEach(add => {
                  const a = s.addresses.find(_a => _a[0] === add)
                  if (a) {
                    a[1] = blockNumber.toString()
                  }
                })
                return this._saveState(s)
              })
          )
          .retryWhen(errs => errs
            .do(e => console.warn('ERR', e))
            .delay(1000))
      )

  private _monitorTransactions = () =>
    this._transactions
      .mergeMap(t =>
        Observable.timer(0, TRANSACTION_INTERVAL)
          .switchMap(() =>
            Observable.defer(() => this._cfg.getTransactionReceipt(t))
              .catch((err) => {
                console.log('TRANSACTION_MONITORING_ERROR', err)
                return Observable.empty()
              })
          )
          .take(1)
      )

  private _saveState = (s: State) =>
    this._cfg.storage.setItem(KEY_PREFIX + this._cfg.channelManagerAddress, JSON.stringify(s))
}
