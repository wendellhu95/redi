import { getDependencies } from './decorators'
import {
	Dependency,
	DependencyCollection,
	DependencyNotFoundError,
	DependencyOrInstance,
	ResolvedDependencyCollection,
} from './dependencyCollection'
import { normalizeFactoryDeps } from './dependencyDescriptor'
import { normalizeForwardRef } from './dependencyForwardRef'
import { DependencyIdentifier } from './dependencyIdentifier'
import {
	AsyncDependencyItem,
	AsyncHook,
	ClassDependencyItem,
	Ctor,
	DependencyItem,
	FactoryDependencyItem,
	ValueDependencyItem,
	isAsyncDependencyItem,
	isAsyncHook,
	isClassDependencyItem,
	isCtor,
	isFactoryDependencyItem,
	isValueDependencyItem,
	prettyPrintIdentifier,
} from './dependencyItem'
import { RediError } from './error'
import { IdleValue } from './idleValue'
import { LookUp, Quantity } from './types'

const MAX_RESOLUTIONS_QUEUED = 300

const NotInstantiatedSymbol = Symbol('$$NOT_INSTANTIATED_SYMBOL')

class CircularDependencyError<T> extends RediError {
	constructor(id: DependencyIdentifier<T>) {
		super(`Detecting cyclic dependency. The last identifier is "${prettyPrintIdentifier(id)}".`)
	}
}

class InjectorAlreadyDisposedError extends RediError {
	constructor() {
		super('Injector cannot be accessed after it was disposed.')
	}
}

class AsyncItemReturnAsyncItemError<T> extends RediError {
	constructor(id: DependencyIdentifier<T>) {
		super(`Async item "${prettyPrintIdentifier(id)}" returns another async item.`)
	}
}

class GetAsyncItemFromSyncApiError<T> extends RediError {
	constructor(id: DependencyIdentifier<T>) {
		super(`Cannot get async item "${prettyPrintIdentifier(id)}" from sync api.`)
	}
}

class AddDependencyAfterResolutionError<T> extends RediError {
	constructor(id: DependencyIdentifier<T>) {
		super(`Cannot add dependency "${prettyPrintIdentifier(id)}" after it is already resolved.`)
	}
}

class DeleteDependencyAfterResolutionError<T> extends RediError {
	constructor(id: DependencyIdentifier<T>) {
		super(`Cannot dependency dependency "${prettyPrintIdentifier(id)}" after it is already resolved.`)
	}
}

export interface IAccessor {
	get: Injector['get']
}

/**
 *
 */
export class Injector {
	private readonly dependencyCollection: DependencyCollection
	private readonly resolvedDependencyCollection: ResolvedDependencyCollection

	private readonly children: Injector[] = []

	private resolutionOngoing = 0

	private disposed = false

	/**
	 * Create a new `Injector` instance
	 * @param dependencies Dependencies that should be resolved by this injector instance.
	 * @param parent Optional parent injector.
	 */
	constructor(dependencies?: Dependency[], private readonly parent: Injector | null = null) {
		this.dependencyCollection = new DependencyCollection(dependencies || [])
		this.resolvedDependencyCollection = new ResolvedDependencyCollection()

		if (parent) {
			parent.children.push(this)
		}
	}

	/**
	 * Create a child inject with a set of dependencies.
	 * @param dependencies Dependencies that should be resolved by the newly created child injector.
	 * @returns The child injector.
	 */
	public createChild(dependencies?: Dependency[]): Injector {
		this.ensureInjectorNotDisposed()
		return new Injector(dependencies, this)
	}

	/**
	 * Dispose the injector and all dependencies held by this injector. Note that its child injectors will dispose first.
	 */
	public dispose(): void {
		// Dispose child injectors first.
		this.children.forEach((c) => c.dispose())
		this.children.length = 0

		// Call `dispose` method on each instantiated dependencies if they are `IDisposable` and clear collections.
		this.dependencyCollection.dispose()
		this.resolvedDependencyCollection.dispose()

		this.deleteSelfFromParent()

		this.disposed = true
	}

	private deleteSelfFromParent(): void {
		if (this.parent) {
			const index = this.parent.children.indexOf(this)
			if (index > -1) {
				this.parent.children.splice(index, 1)
			}
		}
	}

	/**
	 * Add a dependency or its instance into injector. It would throw an error if the dependency
	 * has already been instantiated.
	 *
	 * @param dependency The dependency or an instance that would be add in the injector.
	 */
	public add<T>(dependency: DependencyOrInstance<T>): void {
		this.ensureInjectorNotDisposed()
		const identifierOrCtor = dependency[0]
		const item = dependency[1]

		if (this.resolvedDependencyCollection.has(identifierOrCtor)) {
			throw new AddDependencyAfterResolutionError(identifierOrCtor)
		}

		if (typeof item === 'undefined') {
			// Add dependency
			this.dependencyCollection.add(identifierOrCtor as Ctor<T>)
		} else if (
			isAsyncDependencyItem(item) ||
			isClassDependencyItem(item) ||
			isValueDependencyItem(item) ||
			isFactoryDependencyItem(item)
		) {
			// Add dependency
			this.dependencyCollection.add(identifierOrCtor, item as DependencyItem<T>)
		} else {
			// Add instance
			this.resolvedDependencyCollection.add(identifierOrCtor, item as T)
		}
	}

	/**
	 * Replace an injection mapping for interface-based injection. It would throw an error if the dependency
	 * has already been instantiated.
	 *
	 * @param dependency The dependency that will replace the already existed dependency.
	 */
	public replace<T>(dependency: Dependency<T>): void {
		this.ensureInjectorNotDisposed()

		const identifier = dependency[0]
		if (this.resolvedDependencyCollection.has(identifier)) {
			throw new AddDependencyAfterResolutionError(identifier)
		}

		this.dependencyCollection.delete(identifier)
		if (dependency.length === 1) {
			this.dependencyCollection.add(identifier as Ctor<T>)
		} else {
			this.dependencyCollection.add(identifier, dependency[1])
		}
	}

	/**
	 * Delete a dependency from an injector. It would throw an error when the deleted dependency
	 * has already been instantiated.
	 *
	 * @param identifier The identifier of the dependency that is supposed to be deleted.
	 */
	public delete<T>(identifier: DependencyIdentifier<T>): void {
		this.ensureInjectorNotDisposed()

		if (this.resolvedDependencyCollection.has(identifier)) {
			throw new DeleteDependencyAfterResolutionError(identifier)
		}

		this.dependencyCollection.delete(identifier)
	}

	/**
	 * Invoke a function with dependencies injected. The function could only get dependency from the injector
	 * and other methods are not accessible for the function.
	 *
	 * @param cb the function to be executed
	 * @param args arguments to be passed into the function
	 * @returns the return value of the function
	 */
	invoke<T, P extends any[] = []>(cb: (accessor: IAccessor, ...args: P) => T, ...args: P): T {
		const accessor: IAccessor = {
			get: <D>(id: DependencyIdentifier<D>, quantityOrLookup?: Quantity | LookUp, lookUp?: LookUp) => {
				return this._get(id, quantityOrLookup, lookUp)
			},
		}

		return cb(accessor, ...args)
	}

	/**
	 * Check if the injector could initialize a dependency.
	 *
	 * @param id Identifier of the dependency
	 */
	public has<T>(id: DependencyIdentifier<T>): boolean {
		return this.dependencyCollection.has(id) || this.parent?.has(id) || false
	}

	public get<T>(id: DependencyIdentifier<T>, lookUp?: LookUp): T
	public get<T>(id: DependencyIdentifier<T>, quantity: Quantity.MANY, lookUp?: LookUp): T[]
	public get<T>(id: DependencyIdentifier<T>, quantity: Quantity.OPTIONAL, lookUp?: LookUp): T | null
	public get<T>(id: DependencyIdentifier<T>, quantity: Quantity.REQUIRED, lookUp?: LookUp): T
	public get<T>(id: DependencyIdentifier<T>, quantity?: Quantity, lookUp?: LookUp): T[] | T | null
	public get<T>(id: DependencyIdentifier<T>, quantityOrLookup?: Quantity | LookUp, lookUp?: LookUp): T[] | T | null
	/**
	 * Get dependency instance(s).
	 *
	 * @param id Identifier of the dependency
	 * @param quantityOrLookup @link{Quantity} or @link{LookUp}
	 * @param lookUp @link{LookUp}
	 */
	public get<T>(id: DependencyIdentifier<T>, quantityOrLookup?: Quantity | LookUp, lookUp?: LookUp): T[] | T | null {
		const newResult = this._get(id, quantityOrLookup, lookUp)

		if ((Array.isArray(newResult) && newResult.some((r) => isAsyncHook(r))) || isAsyncHook(newResult)) {
			throw new GetAsyncItemFromSyncApiError(id)
		}

		return newResult as T | T[] | null
	}

	private _get<T>(
		id: DependencyIdentifier<T>,
		quantityOrLookup?: Quantity | LookUp,
		lookUp?: LookUp,
		toSelf?: boolean
	): T[] | T | AsyncHook<T> | null {
		this.ensureInjectorNotDisposed()

		let quantity: Quantity = Quantity.REQUIRED
		if (
			quantityOrLookup === Quantity.REQUIRED ||
			quantityOrLookup === Quantity.OPTIONAL ||
			quantityOrLookup === Quantity.MANY
		) {
			quantity = quantityOrLookup as Quantity
		} else {
			lookUp = quantityOrLookup as LookUp
		}

		if (!toSelf) {
			// see if the dependency is already resolved, return it and check quantity
			const cachedResult = this.getValue(id, quantity, lookUp)
			if (cachedResult !== NotInstantiatedSymbol) {
				return cachedResult
			}
		}

		// see if the dependency can be instantiated by itself or its parent
		return this.createDependency(id, quantity, lookUp, !toSelf) as T[] | T | AsyncHook<T> | null
	}

	/**
	 * Get a dependency in the async way.
	 */
	public getAsync<T>(id: DependencyIdentifier<T>): Promise<T> {
		this.ensureInjectorNotDisposed()

		const cachedResult = this.getValue(id, Quantity.REQUIRED)
		if (cachedResult !== NotInstantiatedSymbol) {
			return Promise.resolve(cachedResult as T)
		}

		const newResult = this.createDependency(id, Quantity.REQUIRED)
		if (!isAsyncHook(newResult)) {
			return Promise.resolve(newResult as T)
		}

		return newResult.whenReady()
	}

	/**
	 * Instantiate a class. The created instance would not be held by the injector.
	 */
	public createInstance<T extends unknown[], U extends unknown[], C>(
		ctor: new (...args: [...T, ...U]) => C,
		...customArgs: T
	): C {
		this.ensureInjectorNotDisposed()

		return this._resolveClass(ctor as Ctor<C>, ...customArgs)
	}

	private resolveDependency<T>(
		id: DependencyIdentifier<T>,
		item: DependencyItem<T>,
		shouldCache = true
	): T | AsyncHook<T> {
		if (isValueDependencyItem(item)) {
			return this.resolveValueDependency(id, item as ValueDependencyItem<T>)
		} else if (isFactoryDependencyItem(item)) {
			return this.resolveFactory(id, item as FactoryDependencyItem<T>, shouldCache)
		} else if (isClassDependencyItem(item)) {
			return this.resolveClass(id, item as ClassDependencyItem<T>, shouldCache)
		} else {
			return this.resolveAsync(id, item as AsyncDependencyItem<T>)
		}
	}

	private resolveValueDependency<T>(id: DependencyIdentifier<T>, item: ValueDependencyItem<T>): T {
		const thing = item.useValue
		this.resolvedDependencyCollection.add(id, thing)
		return thing
	}

	private resolveClass<T>(id: DependencyIdentifier<T> | null, item: ClassDependencyItem<T>, shouldCache = true): T {
		const ctor = item.useClass
		let thing: T

		if (item.lazy) {
			const idle = new IdleValue<T>(() => this._resolveClass(ctor))
			thing = new Proxy(Object.create(null), {
				get(target: any, key: string | number | symbol): any {
					if (key in target) {
						return target[key] // such as toString
					}

					// hack checking if it's a async loader
					if (key === 'whenReady') {
						return undefined
					}

					const hasInstantiated = idle.hasRun()
					const thing = idle.getValue()
					if (!hasInstantiated) {
						item.onInstantiation?.(thing)
					}

					let property = (thing as any)[key]
					if (typeof property !== 'function') {
						return property
					}

					property = property.bind(thing)
					target[key] = property

					return property
				},
				set(_target: any, key: string | number | symbol, value: any): boolean {
					;(idle.getValue() as any)[key] = value
					return true
				},
			})
		} else {
			thing = this._resolveClass(ctor)
		}

		if (id && shouldCache) {
			this.resolvedDependencyCollection.add(id, thing)
		}

		return thing
	}

	private _resolveClass<T>(ctor: Ctor<T>, ...extraParams: any[]) {
		this.markNewResolution(ctor)

		const declaredDependencies = getDependencies(ctor)
			.sort((a, b) => a.paramIndex - b.paramIndex)
			.map((descriptor) => ({
				...descriptor,
				identifier: normalizeForwardRef(descriptor.identifier),
			}))

		const resolvedArgs: any[] = []

		for (const dep of declaredDependencies) {
			// recursive happens here
			const thing = this._get(dep.identifier, dep.quantity, dep.lookUp, dep.withNew)
			resolvedArgs.push(thing)
		}

		let args = [...extraParams]
		const firstDependencyArgIndex =
			declaredDependencies.length > 0 ? declaredDependencies[0].paramIndex : args.length

		if (args.length !== firstDependencyArgIndex) {
			console.warn(
				`[redi]: Expect ${firstDependencyArgIndex} custom parameter(s) of ${ctor.toString()} but get ${
					args.length
				}.`
			)

			const delta = firstDependencyArgIndex - args.length
			if (delta > 0) {
				args = [...args, ...new Array(delta).fill(undefined)]
			} else {
				args = args.slice(0, firstDependencyArgIndex)
			}
		}

		const thing = new ctor(...args, ...resolvedArgs)

		this.markResolutionCompleted()

		return thing
	}

	private resolveFactory<T>(id: DependencyIdentifier<T>, item: FactoryDependencyItem<T>, shouldCache: boolean): T {
		this.markNewResolution(id)

		const declaredDependencies = normalizeFactoryDeps(item.deps)

		const resolvedArgs: any[] = []
		for (const dep of declaredDependencies) {
			const thing = this._get(dep.identifier, dep.quantity, dep.lookUp, dep.withNew)
			resolvedArgs.push(thing)
		}

		const thing = item.useFactory.apply(null, resolvedArgs)

		if (shouldCache) {
			this.resolvedDependencyCollection.add(id, thing)
		}

		this.markResolutionCompleted()

		item?.onInstantiation?.(thing)

		return thing
	}

	private resolveAsync<T>(id: DependencyIdentifier<T>, item: AsyncDependencyItem<T>): AsyncHook<T> {
		const asyncLoader: AsyncHook<T> = {
			whenReady: () => this._resolveAsync(id, item),
		}
		return asyncLoader
	}

	private _resolveAsync<T>(id: DependencyIdentifier<T>, item: AsyncDependencyItem<T>): Promise<T> {
		return item.useAsync().then((thing) => {
			// check if another promise has been resolved,
			// do not resolve the async item twice
			const resolvedCheck = this.getValue(id)
			if (resolvedCheck !== NotInstantiatedSymbol) {
				return resolvedCheck as T
			}

			let ret: T
			if (Array.isArray(thing)) {
				const item = thing[1]
				if (isAsyncDependencyItem(item)) {
					throw new AsyncItemReturnAsyncItemError(id)
				} else {
					ret = this.resolveDependency(id, item) as T
				}
			} else if (isCtor(thing)) {
				ret = this._resolveClass(thing)
			} else {
				ret = thing
			}

			this.resolvedDependencyCollection.add(id, ret)

			return ret
		})
	}

	private getValue<T>(
		id: DependencyIdentifier<T>,
		quantity: Quantity = Quantity.REQUIRED,
		lookUp?: LookUp
	): null | T | T[] | typeof NotInstantiatedSymbol {
		const onSelf = () => {
			if (this.dependencyCollection.has(id) && !this.resolvedDependencyCollection.has(id)) {
				return NotInstantiatedSymbol
			}

			return this.resolvedDependencyCollection.get(id, quantity)
		}

		const onParent = () => {
			if (this.parent) {
				return this.parent.getValue(id, quantity)
			} else {
				return NotInstantiatedSymbol
			}
		}

		if (lookUp === LookUp.SKIP_SELF) {
			return onParent()
		}

		if (lookUp === LookUp.SELF) {
			return onSelf()
		}

		if (this.resolvedDependencyCollection.has(id) || this.dependencyCollection.has(id)) {
			return onSelf()
		}

		return onParent()
	}

	private createDependency<T>(
		id: DependencyIdentifier<T>,
		quantity: Quantity = Quantity.REQUIRED,
		lookUp?: LookUp,
		shouldCache = true
	): null | T | T[] | AsyncHook<T> | (T | AsyncHook<T>)[] {
		const onSelf = () => {
			const registrations = this.dependencyCollection.get(id, quantity)

			let ret: (T | AsyncHook<T>)[] | T | AsyncHook<T> | null = null
			if (Array.isArray(registrations)) {
				ret = registrations.map((dependencyItem) => this.resolveDependency(id, dependencyItem, shouldCache))
			} else if (registrations) {
				ret = this.resolveDependency(id, registrations, shouldCache)
			}

			return ret
		}

		const onParent = () => {
			if (this.parent) {
				return this.parent.createDependency(id, quantity, undefined, shouldCache)
			} else {
				if (quantity === Quantity.OPTIONAL) {
					return null
				}

				throw new DependencyNotFoundError(id)
			}
		}

		if (lookUp === LookUp.SKIP_SELF) {
			return onParent()
		}

		if ((id as any as Ctor<Injector>) === Injector) {
			return this as any as T
		}

		if (this.dependencyCollection.has(id)) {
			return onSelf()
		}

		return onParent()
	}

	private markNewResolution<T>(id: DependencyIdentifier<T>): void {
		this.resolutionOngoing += 1

		if (this.resolutionOngoing >= MAX_RESOLUTIONS_QUEUED) {
			throw new CircularDependencyError(id)
		}
	}

	private markResolutionCompleted(): void {
		this.resolutionOngoing -= 1
	}

	private ensureInjectorNotDisposed(): void {
		if (this.disposed) {
			throw new InjectorAlreadyDisposedError()
		}
	}
}
