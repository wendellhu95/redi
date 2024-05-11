import {
  DependencyIdentifier,
  IdentifierDecoratorSymbol,
} from './dependencyIdentifier'
import { Self, SkipSelf } from './dependencyLookUp'
import { Many, Optional } from './dependencyQuantity'
import { WithNew } from './dependencyWithNew'

export interface Ctor<T> {
  new(...args: any[]): T

  name: string
}
export function isCtor<T>(thing: unknown): thing is Ctor<T> {
  return typeof thing === 'function'
}

export interface DependencyItemHooks<T> {
  onInstantiation?: (instance: T) => void
}

export interface ClassDependencyItem<T> extends DependencyItemHooks<T> {
  useClass: Ctor<T>
  lazy?: boolean
}
export function isClassDependencyItem<T>(
  thing: unknown
): thing is ClassDependencyItem<T> {
  if (thing && typeof (thing as any).useClass !== 'undefined') {
    return true
  }

  return false
}

export type FactoryDepModifier =
  | typeof Self
  | typeof SkipSelf
  | typeof Optional
  | typeof Many
  | typeof WithNew

export type FactoryDep<T> =
  | [...FactoryDepModifier[], DependencyIdentifier<T>]
  | DependencyIdentifier<T>

export interface FactoryDependencyItem<T> extends DependencyItemHooks<T> {
  useFactory: (...deps: any[]) => T
  dynamic?: true
  deps?: FactoryDep<any>[]
}
export function isFactoryDependencyItem<T>(
  thing: unknown
): thing is FactoryDependencyItem<T> {
  if (thing && typeof (thing as any).useFactory !== 'undefined') {
    return true
  }

  return false
}

export interface ValueDependencyItem<T> extends DependencyItemHooks<T> {
  useValue: T
}
export function isValueDependencyItem<T>(
  thing: unknown
): thing is ValueDependencyItem<T> {
  if (thing && typeof (thing as any).useValue !== 'undefined') {
    return true
  }

  return false
}

export interface ExistingDependencyItem<T> extends DependencyItemHooks<T> {
  useExisting: DependencyIdentifier<T>
}
export function isExistingDependencyItem<T>(
  thing: unknown
): thing is ExistingDependencyItem<T> {
  if (thing && typeof (thing as any).useExisting !== 'undefined') {
    return true
  }

  return false
}

export interface AsyncDependencyItem<T> extends DependencyItemHooks<T> {
  useAsync: () => Promise<
    T | Ctor<T> | [DependencyIdentifier<T>, SyncDependencyItem<T>]
  >
}
export function isAsyncDependencyItem<T>(
  thing: unknown
): thing is AsyncDependencyItem<T> {
  if (thing && typeof (thing as any).useAsync !== 'undefined') {
    return true
  }

  return false
}

export const AsyncHookSymbol = Symbol('AsyncHook')
export interface AsyncHook<T> {
  __symbol: typeof AsyncHookSymbol
  whenReady(): Promise<T>
}
export function isAsyncHook<T>(thing: unknown): thing is AsyncHook<T> {
  if (thing && (thing as any)['__symbol'] === AsyncHookSymbol) {
    // FIXME@wzhudev: should not be undefined but a symbol here
    return true
  }

  return false
}

export type SyncDependencyItem<T> =
  | ClassDependencyItem<T>
  | FactoryDependencyItem<T>
  | ExistingDependencyItem<T>
  | ValueDependencyItem<T>

export type DependencyItem<T> = SyncDependencyItem<T> | AsyncDependencyItem<T>

export function prettyPrintIdentifier<T>(id: DependencyIdentifier<T>): string {
  if (typeof id === 'undefined') {
    return 'undefined'
  }

  return isCtor(id) && !(id as any)[IdentifierDecoratorSymbol]
    ? id.name
    : id.toString()
}
