/*!
 * ${copyright}
 */

//Provides class sap.ui.model.odata.v4.ODataListBinding
sap.ui.define([
	"jquery.sap.global",
	"sap/ui/model/Binding",
	"sap/ui/model/ChangeReason",
	"sap/ui/model/FilterOperator",
	"sap/ui/model/FilterType",
	"sap/ui/model/ListBinding",
	"sap/ui/model/Sorter",
	"sap/ui/model/odata/OperationMode",
	"./Context",
	"./lib/_Cache",
	"./lib/_Helper",
	"./lib/_SyncPromise",
	"./ODataParentBinding"
], function (jQuery, Binding, ChangeReason, FilterOperator, FilterType, ListBinding, Sorter,
		OperationMode, Context, _Cache, _Helper, _SyncPromise, asODataParentBinding) {
	"use strict";

	var sClassName = "sap.ui.model.odata.v4.ODataListBinding",
		mSupportedEvents = {
			change : true,
			dataReceived : true,
			dataRequested : true,
			refresh : true
		};

	/**
	 * Do <strong>NOT</strong> call this private constructor, but rather use
	 * {@link sap.ui.model.odata.v4.ODataModel#bindList} instead!
	 *
	 * @param {sap.ui.model.odata.v4.ODataModel} oModel
	 *   The OData V4 model
	 * @param {string} sPath
	 *   The binding path in the model; must not end with a slash
	 * @param {sap.ui.model.Context} [oContext]
	 *   The parent context which is required as base for a relative path
	 * @param {sap.ui.model.Sorter | sap.ui.model.Sorter[]} [vSorters]
	 *   The dynamic sorters to be used initially; supported since 1.39.0
	 * @param {sap.ui.model.Filter | sap.ui.model.Filter[]} [vFilters]
	 *   The dynamic application filters to be used initially; supported since 1.39.0
	 * @param {object} [mParameters]
	 *   Map of binding parameters
	 * @throws {Error}
	 *   If disallowed binding parameters are provided or an unsupported operation mode is used
	 *
	 * @alias sap.ui.model.odata.v4.ODataListBinding
	 * @author SAP SE
	 * @class List binding for an OData V4 model.
	 *   An event handler can only be attached to this binding for the following events: 'change',
	 *   'dataReceived', 'dataRequested', and 'refresh'.
	 *   For other events, an error is thrown.
	 * @extends sap.ui.model.ListBinding
	 * @mixes sap.ui.model.odata.v4.ODataParentBinding
	 * @public
	 * @since 1.37.0
	 * @version ${version}
	 * @borrows sap.ui.model.odata.v4.ODataBinding#hasPendingChanges as #hasPendingChanges
	 * @borrows sap.ui.model.odata.v4.ODataBinding#isInitial as #isInitial
	 * @borrows sap.ui.model.odata.v4.ODataBinding#refresh as #refresh
	 * @borrows sap.ui.model.odata.v4.ODataBinding#resetChanges as #resetChanges
	 * @borrows sap.ui.model.odata.v4.ODataBinding#resume as #resume
	 * @borrows sap.ui.model.odata.v4.ODataBinding#suspend as #suspend
	 * @borrows sap.ui.model.odata.v4.ODataParentBinding#changeParameters as #changeParameters
	 * @borrows sap.ui.model.odata.v4.ODataParentBinding#initialize as #initialize
	 */
	var ODataListBinding = ListBinding.extend("sap.ui.model.odata.v4.ODataListBinding", {
			constructor : function (oModel, sPath, oContext, vSorters, vFilters, mParameters) {
				ListBinding.call(this, oModel, sPath);

				if (sPath.slice(-1) === "/") {
					throw new Error("Invalid path: " + sPath);
				}
				this.mAggregatedQueryOptions = {};
				this.aApplicationFilters = _Helper.toArray(vFilters);
				this.oCachePromise = _SyncPromise.resolve();
				this.sChangeReason = oModel.bAutoExpandSelect ? "AddVirtualContext" : undefined;
				// auto-$expand/$select: promises to wait until child bindings have provided
				// their path and query options
				this.aChildCanUseCachePromises = [];
				this.oDiff = undefined;
				this.aFilters = [];
				this.mPreviousContextsByPath = {};
				this.aPreviousData = [];
				this.sRefreshGroupId = undefined;
				this.aSorters = _Helper.toArray(vSorters);

				this.applyParameters(jQuery.extend(true, {}, mParameters));
				this.oHeaderContext = this.bRelative
					? null
					: Context.create(this.oModel, this, sPath);
				this.setContext(oContext);
				oModel.bindingCreated(this);
			}
		});

	asODataParentBinding(ODataListBinding.prototype);

	/**
	 * Deletes the entity identified by the edit URL.
	 *
	 * @param {string} [sGroupId=getUpdateGroupId()]
	 *   The group ID to be used for the DELETE request
	 * @param {string} sEditUrl
	 *   The edit URL to be used for the DELETE request
	 * @param {number} oContext
	 *   The context to be deleted
	 * @returns {Promise}
	 *   A promise which is resolved without a result in case of success, or rejected with an
	 *   instance of <code>Error</code> in case of failure.
	 * @throws {Error}
	 *   If there are pending changes.
	 *
	 * @private
	 */
	ODataListBinding.prototype._delete = function (sGroupId, sEditUrl, oContext) {
		var that = this;

		if (!oContext.isTransient() && this.hasPendingChanges()) {
			throw new Error("Cannot delete due to pending changes");
		}
		return this.deleteFromCache(sGroupId, sEditUrl, String(oContext.iIndex),
			function (iIndex, aEntities) {
				var sContextPath, i, sPredicate, sResolvedPath;

				if (iIndex === -1) {
					// happens only for a created context that is not transient anymore
					oContext.destroy();
					delete that.aContexts[-1];
				} else {
					// prepare all contexts for deletion
					for (i = iIndex; i < that.aContexts.length; i += 1) {
						oContext = that.aContexts[i];
						if (oContext) {
							that.mPreviousContextsByPath[oContext.getPath()] = oContext;
						}
					}
					sResolvedPath = that.oModel.resolve(that.sPath, that.oContext);
					that.aContexts.splice(iIndex, 1); // adjust the contexts array
					for (i = iIndex; i < that.aContexts.length; i += 1) {
						if (that.aContexts[i]) {
							// calculate the context path and try to re-use the context for it
							sPredicate = aEntities[i]["@$ui5.predicate"];
							sContextPath = sResolvedPath + (sPredicate || "/" + i);
							oContext = that.mPreviousContextsByPath[sContextPath];
							if (oContext) {
								delete that.mPreviousContextsByPath[sContextPath];
								if (oContext.getIndex() === i) {
									oContext.checkUpdate(); // same row, but different data
								} else {
									oContext.setIndex(i); // same data, but different row
								}
							} else {
								oContext = Context.create(that.oModel, that, sContextPath, i);
							}
							that.aContexts[i] = oContext;
						}
					}
				}
				that.iMaxLength -= 1; // this doesn't change Infinity
				that._fireChange({reason : ChangeReason.Remove});
			});
	};

	/**
	 * The 'change' event is fired when the binding is initialized or new contexts are created or
	 * its parent context is changed. It is to be used by controls to get notified about changes to
	 * the binding contexts of this list binding. Registered event handlers are called with the
	 * change reason as parameter.
	 *
	 * @param {sap.ui.base.Event} oEvent
	 * @param {object} oEvent.getParameters
	 * @param {sap.ui.model.ChangeReason} oEvent.getParameters.reason
	 *   The reason for the 'change' event: {@link sap.ui.model.ChangeReason.Change} when the
	 *   binding is initialized and or a new context is created, or
	 *   {@link sap.ui.model.ChangeReason.Context} when the parent context is changed
	 *
	 * @event
	 * @name sap.ui.model.odata.v4.ODataListBinding#change
	 * @public
	 * @see sap.ui.base.Event
	 * @since 1.37.0
	 */

	/**
	 * The 'dataRequested' event is fired directly after data has been requested from a back end.
	 * It is to be used by applications for example to switch on a busy indicator.
	 * Registered event handlers are called without parameters.
	 *
	 * @param {sap.ui.base.Event} oEvent
	 *
	 * @event
	 * @name sap.ui.model.odata.v4.ODataListBinding#dataRequested
	 * @public
	 * @see sap.ui.base.Event
	 * @since 1.37.0
	 */

	/**
	 * Applies the given map of parameters to this binding's parameters and triggers the
	 * creation of a new cache if called with a change reason.
	 *
	 * @param {object} [mParameters]
	 *   Map of binding parameters, {@link sap.ui.model.odata.v4.ODataModel#constructor}
	 * @param {sap.ui.model.ChangeReason} [sChangeReason]
	 *   A change reason for {@link #reset}
	 * @throws {Error}
	 *   If disallowed binding parameters are provided or an unsupported operation mode is used
	 *
	 * @private
	 */
	ODataListBinding.prototype.applyParameters = function (mParameters, sChangeReason) {
		var oBindingParameters = this.oModel.buildBindingParameters(mParameters,
				["$$groupId", "$$operationMode", "$$updateGroupId"]),
			sOperationMode;

		sOperationMode = oBindingParameters.$$operationMode || this.oModel.sOperationMode;
		// Note: $$operationMode is validated before, this.oModel.sOperationMode also
		// Just check for the case that no mode was specified, but sort/filter takes place
		if (!sOperationMode && (this.aSorters.length || this.aApplicationFilters.length)) {
			throw new Error("Unsupported operation mode: " + sOperationMode);
		}
		this.sOperationMode = sOperationMode;

		this.sGroupId = oBindingParameters.$$groupId;
		this.sUpdateGroupId = oBindingParameters.$$updateGroupId;
		this.mQueryOptions = this.oModel.buildQueryOptions(mParameters, true);
		this.mParameters = mParameters; // store mParameters at binding after validation

		this.mCacheByContext = undefined;
		this.fetchCache(this.oContext);
		this.reset(sChangeReason);
	};

	/**
	 * The 'dataReceived' event is fired after the back-end data has been processed and the
	 * registered 'change' event listeners have been notified.
	 * It is to be used by applications for example to switch off a busy indicator or to process an
	 * error.
	 * If back-end requests are successful, the event has almost no parameters. For compatibility
	 * with {@link sap.ui.model.Binding#event:dataReceived}, an event parameter
	 * <code>data : {}</code> is provided: "In error cases it will be undefined", but otherwise it
	 * is not. Use the binding's contexts via
	 * {@link #getCurrentContexts oEvent.getSource().getCurrentContexts()} to access the response
	 * data. Note that controls bound to this data may not yet have been updated, meaning it is not
	 * safe for registered event handlers to access data via control APIs.
	 *
	 * If a back-end request fails, the 'dataReceived' event provides an <code>Error</code> in the
	 * 'error' event parameter.
	 *
	 * @param {sap.ui.base.Event} oEvent
	 * @param {object} oEvent.getParameters
	 * @param {object} [oEvent.getParameters.data]
	 *   An empty data object if a back-end request succeeds
	 * @param {Error} [oEvent.getParameters.error] The error object if a back-end request failed.
	 *   If there are multiple failed back-end requests, the error of the first one is provided.
	 *
	 * @event
	 * @name sap.ui.model.odata.v4.ODataListBinding#dataReceived
	 * @public
	 * @see sap.ui.base.Event
	 * @since 1.37.0
	 */

	// See class documentation
	// @override
	// @public
	// @see sap.ui.base.EventProvider#attachEvent
	// @since 1.37.0
	ODataListBinding.prototype.attachEvent = function (sEventId) {
		if (!(sEventId in mSupportedEvents)) {
			throw new Error("Unsupported event '" + sEventId
				+ "': v4.ODataListBinding#attachEvent");
		}
		return ListBinding.prototype.attachEvent.apply(this, arguments);
	};

	/**
	 * Creates a new entity and inserts it at the beginning of the list. As long as the binding
	 * contains an entity created via this function, you cannot create another entity. This is only
	 * possible after the creation of the entity has been successfully sent to the server and you
	 * have called {@link #refresh} at the (parent) binding, which is absolute or not relative to a
	 * {@link sap.ui.model.odata.v4.Context}, or the new entity is deleted in between.
	 *
	 * For creating the new entity, the binding's update group ID is used, see binding parameter
	 * $$updateGroupId of {@link sap.ui.model.odata.v4.ODataModel#bindList}.
	 *
	 * You can call {@link sap.ui.model.odata.v4.Context#delete} to delete the created context
	 * again. As long as the context is transient (see
	 * {@link sap.ui.model.odata.v4.Context#isTransient}), {@link #resetChanges} and a call to
	 * {@link sap.ui.model.odata.v4.ODataModel#resetChanges} with the update group ID as parameter
	 * also delete the created context together with other changes.
	 *
	 * If the creation of the entity on the server failed, the creation is repeated
	 * automatically. If the binding's update group ID has
	 * {@link sap.ui.model.odata.v4.SubmitMode.API}, it is repeated with the next call of
	 * {@link sap.ui.model.odata.v4.ODataModel#submitBatch}. Otherwise it is repeated with the next
	 * update for the entity.
	 *
	 * @param {object} [oInitialData={}]
	 *   The initial data for the created entity
	 * @returns {sap.ui.model.odata.v4.Context}
	 *   The context object for the created entity
	 * @throws {Error}
	 *   If a relative binding is not yet resolved or if the binding already contains an entity
	 *   created via this function
	 *
	 * @public
	 * @since 1.43.0
	 */
	ODataListBinding.prototype.create = function (oInitialData) {
		var oContext,
			vCreatePath, // {string|SyncPromise}
			oCreatePromise,
			sResolvedPath = this.oModel.resolve(this.sPath, this.oContext),
			that = this;

		if (!sResolvedPath) {
			throw new Error("Binding is not yet resolved: " + this);
		}

		if (this.aContexts[-1]) {
			throw new Error("Must not create twice");
		}

		vCreatePath = sResolvedPath.slice(1);
		if (this.bRelative && this.oContext.fetchCanonicalPath) {
			vCreatePath = this.oContext.fetchCanonicalPath().then(function (sCanonicalPath) {
				return _Helper.buildPath(sCanonicalPath, that.sPath).slice(1);
			});
		}

		oCreatePromise = this.createInCache(this.getUpdateGroupId(), vCreatePath, "", oInitialData,
			function () {
				// cancel callback
				oContext.destroy();
				delete that.aContexts[-1];
				that._fireChange({reason : ChangeReason.Remove});
			}).then(function () {
				that.iMaxLength += 1;
			});
		oContext = Context.create(this.oModel, this, sResolvedPath + "/-1", -1, oCreatePromise);

		this.aContexts[-1] = oContext;
		this._fireChange({reason : ChangeReason.Add});

		return oContext;
	};

	/**
	 * Creates contexts for this list binding in the given range for the given OData response.
	 * Fires change and dataReceived events. Destroys contexts that became
	 * obsolete and shrinks the array by removing trailing <code>undefined</code>.
	 *
	 * @param {number} iStart
	 *   The start index of the range
	 * @param {number} iLength
	 *   The number of contexts in the range
	 * @param {object[]} aResults
	 *   The OData entities read from the cache for the given range
	 * @returns {boolean}
	 *   <code>true</code>, if contexts have been created or dropped or <code>isLengthFinal</code>
	 *   has changed
	 *
	 * @private
	 */
	ODataListBinding.prototype.createContexts = function (iStart, iLength, aResults) {
		var bChanged = false,
			oContext = this.oContext,
			sContextPath,
			i,
			iCount = aResults.$count,
			iInitialLength = this.aContexts.length,
			bLengthFinal = this.bLengthFinal,
			oModel = this.oModel,
			sPath = oModel.resolve(this.sPath, oContext),
			sPredicate,
			that = this;

		/*
		 * Shrinks contexts to the new length, destroys unneeded contexts
		 */
		function shrinkContexts(iNewLength) {
			var i;

			for (i = iNewLength; i < that.aContexts.length; i += 1) {
				if (that.aContexts[i]) {
					that.aContexts[i].destroy();
				}
			}
			while (iNewLength > 0 && !that.aContexts[iNewLength - 1]) {
				iNewLength -= 1;
			}
			that.aContexts.length = iNewLength;
			bChanged = true;
		}

		for (i = iStart; i < iStart + aResults.length; i += 1) {
			if (this.aContexts[i] === undefined) {
				bChanged = true;
				sPredicate = aResults[i - iStart]["@$ui5.predicate"];
				sContextPath = sPath + (sPredicate || "/" + i);
				if (sContextPath in this.mPreviousContextsByPath) {
					this.aContexts[i] = this.mPreviousContextsByPath[sContextPath];
					delete this.mPreviousContextsByPath[sContextPath];
					this.aContexts[i].setIndex(i);
					this.aContexts[i].checkUpdate();
				} else {
					this.aContexts[i] = Context.create(oModel, this, sContextPath, i);
				}
			}
		}
		// destroy previous contexts which are not reused
		if (Object.keys(this.mPreviousContextsByPath).length) {
			sap.ui.getCore().addPrerenderingTask(function () {
				Object.keys(that.mPreviousContextsByPath).forEach(function (sPath) {
					that.mPreviousContextsByPath[sPath].destroy();
					delete that.mPreviousContextsByPath[sPath];
				});
			});
		}
		if (iCount !== undefined) {
			if (this.aContexts.length > iCount) {
				shrinkContexts(iCount);
			}
			this.iMaxLength = iCount;
			this.bLengthFinal = true;
		} else {
			if (this.aContexts.length > this.iMaxLength) { // upper boundary obsolete: reset it
				this.iMaxLength = Infinity;
			}
			if (aResults.length < iLength) {
				this.iMaxLength = iStart + aResults.length;
				if (this.aContexts.length > this.iMaxLength) {
					shrinkContexts(this.iMaxLength);
				}
			}
			// If we started to read beyond the range that we read before and the result is
			// empty, we cannot say anything about the length
			if (!(iStart > iInitialLength && aResults.length === 0)) {
				this.bLengthFinal = this.aContexts.length === this.iMaxLength;
			}
		}
		if (this.bLengthFinal !== bLengthFinal) {
			// bLengthFinal changed --> send change event even if no new data is available
			bChanged = true;
		}
		return bChanged;
	};

	/**
	 * Deregisters the given change listener.
	 *
	 * @param {string} sPath
	 *   The path
	 * @param {sap.ui.model.odata.v4.ODataPropertyBinding} oListener
	 *   The change listener
	 * @param {number} iIndex
	 *   Index corresponding to some current context of this binding
	 *
	 * @private
	 */
	ODataListBinding.prototype.deregisterChange = function (sPath, oListener, iIndex) {
		var oCache = this.oCachePromise.getResult();

		if (!this.oCachePromise.isFulfilled()) {
			// Be prepared for late deregistrations by dependents of parked contexts
			return;
		}

		if (oCache) {
			oCache.deregisterChange(_Helper.buildPath(iIndex, sPath), oListener);
		} else if (this.oContext) {
			this.oContext.deregisterChange(_Helper.buildPath(this.sPath, iIndex, sPath),
				oListener);
		}
	};

	/**
	 * Destroys the object. The object must not be used anymore after this function was called.
	 *
	 * @public
	 * @since 1.40.1
	 */
	// @override
	ODataListBinding.prototype.destroy = function () {
		this.aContexts.forEach(function (oContext) {
			oContext.destroy();
		});
		if (this.oHeaderContext) {
			this.oHeaderContext.destroy();
		}
		if (this.aContexts[-1]) {
			this.aContexts[-1].destroy();
		}
		this.oModel.bindingDestroyed(this);
		this.oCachePromise = undefined;
		this.oContext = undefined;
		ListBinding.prototype.destroy.apply(this);
	};

	/**
	 * Hook method for {@link sap.ui.model.odata.v4.ODataBinding#fetchCache} to create a cache for
	 * this binding with the given resource path and query options.
	 *
	 * @param {string} sResourcePath
	 *   The resource path, for example "EMPLOYEES"
	 * @param {object} mQueryOptions
	 *   The query options
	 * @param {sap.ui.model.Context} [oContext]
	 *   The context instance to be used, must be undefined for absolute bindings
	 * @returns {sap.ui.model.odata.v4.lib._Cache}
	 *   The new cache instance
	 *
	 * @private
	 */
	ODataListBinding.prototype.doCreateCache = function (sResourcePath, mQueryOptions, oContext) {
		var mInheritedQueryOptions;

		if (!Object.keys(this.mParameters).length) {
			// mQueryOptions can contain only dynamic filter and sorter AND model options;
			// mix-in inherited static query options
			mInheritedQueryOptions = this.getQueryOptionsForPath("", oContext);
			if (mQueryOptions.$orderby && mInheritedQueryOptions.$orderby) {
				mQueryOptions.$orderby += "," + mInheritedQueryOptions.$orderby;
			}
			if (mQueryOptions.$filter && mInheritedQueryOptions.$filter) {
				mQueryOptions.$filter = "(" + mQueryOptions.$filter + ") and ("
					+ mInheritedQueryOptions.$filter + ")";
			}
			mQueryOptions = jQuery.extend({}, mInheritedQueryOptions, mQueryOptions);
		}
		return _Cache.create(this.oModel.oRequestor, sResourcePath, mQueryOptions,
			this.oModel.bAutoExpandSelect);
	};

	/**
	 * Hook method for {@link sap.ui.model.odata.v4.ODataBinding#fetchQueryOptionsForOwnCache} to
	 * determine the query options for this binding.
	 *
	 * @param {sap.ui.model.Context} oContext
	 *   The context instance to be used
	 * @returns {SyncPromise}
	 *   A promise resolving with the binding's query options
	 *
	 * @private
	 */
	ODataListBinding.prototype.doFetchQueryOptions = function (oContext) {
		var sOrderby = this.getOrderby(this.mQueryOptions.$orderby),
			that = this;

		return this.fetchFilter(oContext, this.mQueryOptions.$filter)
			.then(function (sFilter) {
				return that.mergeQueryOptions(that.mQueryOptions, sOrderby, sFilter);
			});
	};

	/*
	 * Delegates to {@link sap.ui.model.ListBinding#enableExtendedChangeDetection} while disallowing
	 * the <code>vKey</code> parameter.
	 */
	// @override
	ODataListBinding.prototype.enableExtendedChangeDetection = function (bDetectUpdates, vKey) {
		if (vKey !== undefined) {
			throw new Error("Unsupported property 'key' with value '" + vKey
				+ "' in binding info for " + this);
		}

		return ListBinding.prototype.enableExtendedChangeDetection.apply(this, arguments);
	};

	/**
	 * Requests a $filter query option value for the this binding; the value is computed from the
	 * given arrays of dynamic application and control filters and the given static filter.
	 *
	 * @param {sap.ui.model.Context} oContext
	 *   The context instance to be used; it is given as a parameter and this.oContext is unused
	 *   because setContext calls this method (indirectly) before calling the superclass to ensure
	 *   that the cache promise is already created when the events are fired.
	 * @param {string} sStaticFilter
	 *   The static filter value
	 * @returns {SyncPromise} A promise which resolves with the $filter value or "" if the
	 *   filter arrays are empty and the static filter parameter is not given. It rejects with
	 *   an error if a filter has an unknown operator or an invalid path.
	 *
	 * @private
	 */
	ODataListBinding.prototype.fetchFilter = function (oContext, sStaticFilter) {
		var aNonEmptyFilters = [],
			that = this;

		/**
		 * Concatenates the given $filter values using the given separator; the resulting
		 * value is enclosed in parentheses if more than one filter value is given.
		 *
		 * @param {string[]} aFilterValues The filter values
		 * @param {string} sSeparator The separator
		 * @returns {string} The combined filter value
		 */
		function combineFilterValues(aFilterValues, sSeparator) {
			var sFilterValue = aFilterValues.join(sSeparator);

			return aFilterValues.length > 1 ? "(" + sFilterValue + ")" : sFilterValue;
		}

		/**
		 * Returns the $filter value for the given single filter using the given Edm type to
		 * format the filter's operand(s).
		 *
		 * @param {sap.ui.model.Filter} oFilter The filter
		 * @param {string} sEdmType The Edm type
		 * @returns {string} The $filter value
		 */
		function getSingleFilterValue(oFilter, sEdmType) {
			var sFilter,
				sValue = _Helper.formatLiteral(oFilter.oValue1, sEdmType),
				sFilterPath = decodeURIComponent(oFilter.sPath);

			switch (oFilter.sOperator) {
				case FilterOperator.BT :
					sFilter = sFilterPath + " ge " + sValue + " and "
						+ sFilterPath + " le "
						+ _Helper.formatLiteral(oFilter.oValue2, sEdmType);
					break;
				case FilterOperator.EQ :
				case FilterOperator.GE :
				case FilterOperator.GT :
				case FilterOperator.LE :
				case FilterOperator.LT :
				case FilterOperator.NE :
					sFilter = sFilterPath + " " + oFilter.sOperator.toLowerCase() + " "
						+ sValue;
					break;
				case FilterOperator.Contains :
				case FilterOperator.EndsWith :
				case FilterOperator.StartsWith :
					sFilter = oFilter.sOperator.toLowerCase() + "(" + sFilterPath + ","
						+ sValue + ")";
					break;
				default :
					throw new Error("Unsupported operator: " + oFilter.sOperator);
			}
			return sFilter;
		}

		/**
		 * Requests the $filter value for an array of filters; filters with the same path are
		 * grouped with a logical 'or'.
		 *
		 * @param {sap.ui.model.Filter[]} aFilters The non-empty array of filters
		 * @param {boolean} [bAnd] Whether the filters are combined with 'and'; combined with
		 *   'or' if not given
		 * @param {object} mLambdaVariableToPath The map from lambda variable to full path
		 * @returns {SyncPromise} A promise which resolves with the $filter value
		 */
		function fetchArrayFilter(aFilters, bAnd, mLambdaVariableToPath) {
			var aFilterPromises = [],
				mFiltersByPath = {};

			aFilters.forEach(function (oFilter) {
				mFiltersByPath[oFilter.sPath] = mFiltersByPath[oFilter.sPath] || [];
				mFiltersByPath[oFilter.sPath].push(oFilter);
			});
			aFilters.forEach(function (oFilter) {
				var aFiltersForPath;

				if (oFilter.aFilters) { // array filter
					aFilterPromises.push(fetchArrayFilter(oFilter.aFilters, oFilter.bAnd,
						mLambdaVariableToPath).then(function (sArrayFilter) {
							return "(" + sArrayFilter + ")";
						})
					);
					return;
				}
				// single filter
				aFiltersForPath = mFiltersByPath[oFilter.sPath];
				if (!aFiltersForPath) { // filter group for path of oFilter already processed
					return;
				}
				delete mFiltersByPath[oFilter.sPath];
				aFilterPromises.push(fetchGroupFilter(aFiltersForPath, mLambdaVariableToPath));
			});

			return _SyncPromise.all(aFilterPromises).then(function (aFilterValues) {
				return aFilterValues.join(bAnd ? " and " : " or ");
			});
		}

		/**
		 * Requests the $filter value for the given group of filters which all have the same
		 * path and thus refer to the same EDM type; the resulting filter value is
		 * the $filter values for the single filters in the group combined with a logical 'or'.
		 *
		 * @param {sap.ui.model.Filter[]} aGroupFilters The non-empty array of filters
		 * @param {object} mLambdaVariableToPath The map from lambda variable to full path
		 * @returns {SyncPromise} A promise which resolves with the $filter value or rejects
		 *   with an error if the filter value uses an unknown operator
		 */
		function fetchGroupFilter(aGroupFilters, mLambdaVariableToPath) {
			var oMetaModel = that.oModel.getMetaModel(),
				oMetaContext = oMetaModel.getMetaContext(
					that.oModel.resolve(that.sPath, oContext)),
				oPropertyPromise = oMetaModel.fetchObject(
					replaceLambdaVariables(aGroupFilters[0].sPath, mLambdaVariableToPath),
					oMetaContext);

			return oPropertyPromise.then(function (oPropertyMetadata) {
				var aGroupFilterValues;

				if (!oPropertyMetadata) {
					throw new Error("Type cannot be determined, no metadata for path: "
						+ oMetaContext.getPath());
				}

				aGroupFilterValues = aGroupFilters.map(function (oGroupFilter) {
					var oCondition,
						sLambdaVariable,
						sOperator = oGroupFilter.sOperator;

					if (sOperator === FilterOperator.All || sOperator === FilterOperator.Any) {
						oCondition = oGroupFilter.oCondition;
						sLambdaVariable = oGroupFilter.sVariable;
						if (sOperator === FilterOperator.Any && !oCondition) {
							return oGroupFilter.sPath + "/any()";
						}
						// array filters are processed in parallel, so clone mLambdaVariableToPath
						// to allow same lambda variables in different filters
						mLambdaVariableToPath = jQuery.extend({}, mLambdaVariableToPath);
						mLambdaVariableToPath[sLambdaVariable]
							= replaceLambdaVariables(oGroupFilter.sPath, mLambdaVariableToPath);

						return (oCondition.aFilters
								? fetchArrayFilter(oCondition.aFilters, oCondition.bAnd,
									mLambdaVariableToPath)
								: fetchGroupFilter([oCondition], mLambdaVariableToPath)
							).then(function (sFilterValue) {
								return oGroupFilter.sPath + "/"
									+ oGroupFilter.sOperator.toLowerCase()
									+ "(" + sLambdaVariable + ":" + sFilterValue + ")";
							});
					}
					return getSingleFilterValue(oGroupFilter, oPropertyMetadata.$Type);

				});

				return _SyncPromise.all(aGroupFilterValues).then(function (aResolvedFilterValues) {
					return combineFilterValues(aResolvedFilterValues, " or ");
				});
			});
		}

		/**
		 * Replaces an optional lambda variable in the first segment of the given path by the
		 * correct path.
		 *
		 * @param {string} sPath The path with an optional lambda variable at the beginning
		 * @param {object} mLambdaVariableToPath The map from lambda variable to full path
		 * @returns {string} The path with replaced lambda variable
		 */
		function replaceLambdaVariables(sPath, mLambdaVariableToPath) {
			var aSegments = sPath.split("/");

			aSegments[0] = mLambdaVariableToPath[aSegments[0]];
			return aSegments[0] ? aSegments.join("/") : sPath;
		}

		return _SyncPromise.all([
			fetchArrayFilter(this.aApplicationFilters, /*bAnd*/true, {}),
			fetchArrayFilter(this.aFilters, /*bAnd*/true, {})
		]).then(function (aFilterValues) {
			if (aFilterValues[0]) { aNonEmptyFilters.push(aFilterValues[0]); }
			if (aFilterValues[1]) { aNonEmptyFilters.push(aFilterValues[1]); }
			if (sStaticFilter) { aNonEmptyFilters.push(sStaticFilter); }

			return combineFilterValues(aNonEmptyFilters, ") and (");
		});
	};

	/**
	 * Requests the value for the given path and index; the value is requested from this binding's
	 * cache or from its context in case it has no cache.
	 *
	 * @param {string} sPath
	 *   Some absolute path
	 * @param {sap.ui.model.odata.v4.ODataPropertyBinding} [oListener]
	 *   A property binding which registers itself as listener at the cache
	 * @returns {SyncPromise}
	 *   A promise on the outcome of the cache's <code>read</code> call
	 *
	 * @private
	 */
	ODataListBinding.prototype.fetchValue = function (sPath, oListener) {
		var that = this;

		return this.oCachePromise.then(function (oCache) {
			var sRelativePath;

			if (oCache) {
				sRelativePath = that.getRelativePath(sPath);
				if (sRelativePath !== undefined) {
					return oCache.fetchValue(undefined, sRelativePath, undefined, oListener);
				}
			}
			if (that.oContext) {
				return that.oContext.fetchValue(sPath, oListener);
			}
		});
	};

	/**
	 * Filters the list with the given filters.
	 *
	 * If there are pending changes an error is thrown. Use {@link #hasPendingChanges} to check if
	 * there are pending changes. If there are changes, call
	 * {@link sap.ui.model.odata.v4.ODataModel#submitBatch} to submit the changes or
	 * {@link sap.ui.model.odata.v4.ODataModel#resetChanges} to reset the changes before calling
	 * {@link #filter}.
	 *
	 * @param {sap.ui.model.Filter|sap.ui.model.Filter[]} [vFilters]
	 *   The dynamic filters to be used; replaces the dynamic filters given in
	 *   {@link sap.ui.model.odata.v4.ODataModel#bindList}.
	 *   The filter executed on the list is created from the following parts, which are combined
	 *   with a logical 'and':
	 *   <ul>
	 *   <li> Dynamic filters of type {@link sap.ui.model.FilterType.Application}
	 *   <li> Dynamic filters of type {@link sap.ui.model.FilterType.Control}
	 *   <li> The static filters, as defined in the '$filter' binding parameter
	 *   </ul>
	 *
	 * @param {sap.ui.model.FilterType} [sFilterType=sap.ui.model.FilterType.Application]
	 *   The filter type to be used
	 * @returns {sap.ui.model.odata.v4.ODataListBinding}
	 *   <code>this</code> to facilitate method chaining
	 * @throws {Error}
	 *   If there are pending changes or if an unsupported operation mode is used (see
	 *   {@link sap.ui.model.odata.v4.ODataModel#bindList})
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#filter
	 * @since 1.39.0
	 */
	ODataListBinding.prototype.filter = function (vFilters, sFilterType) {
		if (this.sOperationMode !== OperationMode.Server) {
			throw new Error("Operation mode has to be sap.ui.model.odata.OperationMode.Server");
		}
		if (this.hasPendingChanges()) {
			throw new Error("Cannot filter due to pending changes");
		}

		if (sFilterType === FilterType.Control) {
			this.aFilters = _Helper.toArray(vFilters);
		} else {
			this.aApplicationFilters = _Helper.toArray(vFilters);
		}
		this.mCacheByContext = undefined;
		this.fetchCache(this.oContext);
		this.reset(ChangeReason.Filter);

		return this;
	};

	 /**
	 * Returns already created binding contexts for all entities in this list binding for the range
	 * determined by the given start index <code>iStart</code> and <code>iLength</code>.
	 * If at least one of the entities in the given range has not yet been loaded, fires a
	 * {@link #event:change} event on this list binding once these entities have been loaded
	 * <b>asynchronously</b>. A further call to this method in the 'change' event handler with the
	 * same index range then yields the updated array of contexts.
	 *
	 * @param {number} [iStart=0]
	 *   The index where to start the retrieval of contexts
	 * @param {number} [iLength]
	 *   The number of contexts to retrieve beginning from the start index; defaults to the model's
	 *   size limit, see {@link sap.ui.model.Model#setSizeLimit}
	 * @param {number} [iMaximumPrefetchSize=0]
	 *   The maximum number of contexts to read before and after the given range; with this,
	 *   controls can prefetch data that is likely to be needed soon, e.g. when scrolling down in a
	 *   table. Negative values will be treated as 0.
	 *   Supported since 1.39.0
	 * @returns {sap.ui.model.odata.v4.Context[]}
	 *   The array of already created contexts with the first entry containing the context for
	 *   <code>iStart</code>
	 * @throws {Error}
	 *   If extended change detection is enabled and <code>iMaximumPrefetchSize</code> is set or
	 *   <code>iStart</code> is not 0
	 *
	 * @protected
	 * @see sap.ui.model.ListBinding#getContexts
	 * @since 1.37.0
	 */
	ODataListBinding.prototype.getContexts = function (iStart, iLength, iMaximumPrefetchSize) {
		// iStart: in view coordinates (always starting with 0)
		var sChangeReason,
			oContext = this.oContext,
			aContexts,
			bDataRequested = false,
			bFireChange = false,
			sGroupId,
			oPromise,
			bRefreshEvent = !!this.sChangeReason,
			iStartInModel, // in model coordinates
			oVirtualContext,
			that = this;

		jQuery.sap.log.debug(this + "#getContexts(" + iStart + ", " + iLength + ", "
				+ iMaximumPrefetchSize + ")",
			undefined, sClassName);

		if (iStart !== 0 && this.bUseExtendedChangeDetection) {
			throw new Error("Unsupported operation: v4.ODataListBinding#getContexts,"
				+ " first parameter must be 0 if extended change detection is enabled, but is "
				+ iStart);
		}

		if (iMaximumPrefetchSize !== undefined && this.bUseExtendedChangeDetection) {
			throw new Error("Unsupported operation: v4.ODataListBinding#getContexts,"
				+ " third parameter must not be set if extended change detection is enabled");
		}

		if (this.bRelative && !oContext) { // unresolved relative binding
			return [];
		}

		sChangeReason = this.sChangeReason || ChangeReason.Change;
		this.sChangeReason = undefined;

		if (sChangeReason === "AddVirtualContext") {
			// Note: this task is queued _before_ any SubmitMode.Auto task!
			sap.ui.getCore().addPrerenderingTask(function () {
				// Note: first result of getContexts after refresh is ignored
				that.sChangeReason = "RemoveVirtualContext";
				that._fireChange({reason : ChangeReason.Change});
				that.reset(ChangeReason.Refresh);
			}, true);
			oVirtualContext = Context.create(this.oModel, this,
				this.oModel.resolve(this.sPath, this.oContext) + "/-2", -2);
			return [oVirtualContext];
		}

		if (sChangeReason === "RemoveVirtualContext") {
			return [];
		}

		iStart = iStart || 0;
		iLength = iLength || this.oModel.iSizeLimit;
		if (!iMaximumPrefetchSize || iMaximumPrefetchSize < 0) {
			iMaximumPrefetchSize = 0;
		}
		iStartInModel = this.aContexts[-1] ? iStart - 1 : iStart;

		if (!this.bUseExtendedChangeDetection || !this.oDiff) {
			oPromise = this.oCachePromise.then(function (oCache) {
				if (oCache) {
					sGroupId = that.sRefreshGroupId || that.getGroupId();
					that.sRefreshGroupId = undefined;
					return oCache.read(iStartInModel, iLength, iMaximumPrefetchSize, sGroupId,
						function () {
							bDataRequested = true;
							that.fireDataRequested();
						});
				} else {
					return oContext.fetchValue(that.sPath).then(function (aResult) {
						var iCount;

						// aResult may be undefined e.g. in case of a missing $expand in
						// parent binding
						aResult = aResult || [];
						iCount = aResult.$count;
						if (iStartInModel < 0) {
							aResult = [aResult[-1]].concat(aResult.slice(0, iLength - 1));
						} else {
							aResult = aResult.slice(iStartInModel, iStartInModel + iLength);
						}
						aResult.$count = iCount;
						return {
							value : aResult
						};
					});
				}
			});
			if (oPromise.isFulfilled() && bRefreshEvent) {
				// make sure "refresh" is followed by async "change"
				oPromise = Promise.resolve(oPromise);
			}
			oPromise.then(function (oResult) {
				var bChanged;

				// ensure that the result is still relevant
				if (!that.bRelative || that.oContext === oContext) {
					bChanged = that.createContexts(iStartInModel, iLength, oResult.value);
					if (that.bUseExtendedChangeDetection) {
						that.oDiff = {
							// aResult[0] corresponds to oRange.start = iStartInModel for E.C.D.
							aDiff : that.getDiff(oResult.value, iStartInModel),
							iLength : iLength
						};
					}
					if (bFireChange) {
						if (bChanged) {
							that._fireChange({reason : sChangeReason});
						} else { // we cannot keep a diff if we do not tell the control to fetch it!
							that.oDiff = undefined;
						}
					}
				}
				if (bDataRequested) {
					that.fireDataReceived({data : {}});
				}
			}, function (oError) {
				// cache shares promises for concurrent read
				if (bDataRequested) {
					that.fireDataReceived(oError.canceled ? {data : {}} : {error : oError});
				}
				throw oError;
			})["catch"](function (oError) {
				that.oModel.reportError("Failed to get contexts for "
						+ that.oModel.sServiceUrl
						+ that.oModel.resolve(that.sPath, that.oContext).slice(1)
						+ " with start index " + iStart + " and length " + iLength,
					sClassName, oError);
			});
			// in case of asynchronous processing ensure to fire a change event
			bFireChange = true;
		}
		this.iCurrentBegin = iStartInModel;
		this.iCurrentEnd = iStartInModel + iLength;
		if (iStartInModel === -1) {
			aContexts = this.aContexts.slice(0, iStartInModel + iLength);
			aContexts.unshift(this.aContexts[-1]);
		} else {
			aContexts = this.aContexts.slice(iStartInModel, iStartInModel + iLength);
		}
		if (this.bUseExtendedChangeDetection) {
			if (this.oDiff && iLength !== this.oDiff.iLength) {
				throw new Error("Extended change detection protocol violation: Expected "
					+ "getContexts(0," + this.oDiff.iLength + "), but got getContexts(0,"
					+ iLength + ")");
			}
			aContexts.dataRequested = !this.oDiff;
			aContexts.diff = this.oDiff ? this.oDiff.aDiff : [];
		}
		this.oDiff = undefined;
		return aContexts;
	};

	/**
	 * Returns the contexts that were requested by a control last time. Does not trigger a data
	 * request. In the time between the {@link #event:dataRequested} event and the
	 * {@link #event:dataReceived} event, the resulting array contains <code>undefined</code> at
	 * those indexes where the data is not yet available.
	 *
	 * @returns {sap.ui.model.odata.v4.Context[]}
	 *   The contexts
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#getCurrentContexts
	 * @since 1.39.0
	 */
	// @override
	ODataListBinding.prototype.getCurrentContexts = function () {
		var aContexts,
			iLength = Math.min(this.iCurrentEnd, this.iMaxLength) - this.iCurrentBegin;

		if (this.iCurrentBegin === -1) {
			aContexts = this.aContexts.slice(0, this.iCurrentBegin + iLength);
			aContexts.unshift(this.aContexts[-1]);
		} else {
			aContexts = this.aContexts.slice(this.iCurrentBegin, this.iCurrentBegin + iLength);
		}

		while (aContexts.length < iLength) {
			aContexts.push(undefined);
		}
		return aContexts;
	};

	/**
	 * Computes the "diff" needed for extended change detection.
	 *
	 * @param {object[]} aResult
	 *   The array of OData entities read in the last request
	 * @param {number} iStartInModel
	 *   The start index in model coordinates of the range for which the OData entities have been
	 *   read
	 * @returns {object}
	 *   The array of differences which is
	 *   <ul>
	 *   <li>the comparison of aResult with the data retrieved in the previous request, in case of
	 *   <code>this.bDetectUpdates === true</code></li>
	 *   <li>the comparison of current context paths with the context paths of the previous request,
	 *   in case of <code>this.bDetectUpdates === false</code></li>
	 *   </ul>
	 *
	 * @private
	 */
	ODataListBinding.prototype.getDiff = function (aResult, iStartInModel) {
		var aDiff,
			aNewData,
			that = this;

		aNewData = aResult.map(function (oEntity, i) {
			return that.bDetectUpdates
				? JSON.stringify(oEntity)
				: that.aContexts[iStartInModel + i].getPath();
		});
		aDiff = jQuery.sap.arraySymbolDiff(this.aPreviousData, aNewData);
		this.aPreviousData = aNewData;
		return aDiff;
	};

	/**
	 * Method not supported
	 *
	 * @throws {Error}
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#getDistinctValues
	 * @since 1.37.0
	 */
	// @override
	ODataListBinding.prototype.getDistinctValues = function () {
		throw new Error("Unsupported operation: v4.ODataListBinding#getDistinctValues");
	};

	/**
	 * Returns the header context which allows binding to <code>$count</code>. If known, the value
	 * of such a binding is the element count of the collection on the server. Otherwise it is
	 * <code>undefined</code>. The value is a number and its type is <code>Edm.Int64</code>.
	 *
	 * The count is known to the binding in the following situations:
	 * <ul>
	 *   <li>It has been requested from the server via the system query option <code>$count</code>.
	 *   <li>A "short read" in a paged collection (the server delivered less elements than
	 *     requested) indicated that the server has no more unread elements.
	 *   <li>It has been read completely in one request, for example an embedded collection via
	 *     <code>$expand</code>.
	 * </ul>
	 *
	 * The <code>$count</code> is unknown, if the binding is relative, but has no context.
	 *
	 * @returns {sap.ui.model.odata.v4.Context}
	 *   The header context or <code>null</code> if the binding is relative and has no context
	 *
	 * @public
	 * @since 1.45.0
	 */
	ODataListBinding.prototype.getHeaderContext = function () {
		// Since we never throw the header context away, we may deliver it only when valid
		return (this.bRelative && !this.oContext) ? null : this.oHeaderContext;
	};

	/**
	 * Returns the number of entries in the list. As long as the client does not know the size on
	 * the server an estimated length is returned.
	 *
	 * @returns {number}
	 *   The number of entries in the list
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#getLength
	 * @since 1.37.0
	 */
	 // @override
	ODataListBinding.prototype.getLength = function () {
		var iLength = this.bLengthFinal ? this.iMaxLength : this.aContexts.length + 10;

		if (this.aContexts[-1]) {
			iLength += 1; // Note: non-transient created entities exist twice
		}
		return iLength;
	};

	/**
	 * Builds the value for the OData V4 '$orderby' system query option from the given sorters
	 * and the optional static '$orderby' value which is appended to the sorters.
	 *
	 * @param {string} [sOrderbyQueryOption]
	 *   The static '$orderby' system query option which is appended to the converted 'aSorters'
	 *   parameter.
	 * @returns {string}
	 *   The concatenated '$orderby' system query option
	 * @throws {Error}
	 *   If 'aSorters' contains elements that are not {@link sap.ui.model.Sorter} instances.
	 *
	 * @private
	 */
	ODataListBinding.prototype.getOrderby = function (sOrderbyQueryOption) {
		var aOrderbyOptions = [],
			that = this;

		this.aSorters.forEach(function (oSorter) {
			if (oSorter instanceof Sorter) {
				aOrderbyOptions.push(oSorter.sPath + (oSorter.bDescending ? " desc" : ""));
			} else {
				throw new Error("Unsupported sorter: " + oSorter + " - " + that);
			}
		});
		if (sOrderbyQueryOption) {
			aOrderbyOptions.push(sOrderbyQueryOption);
		}
		return aOrderbyOptions.join(',');
	};

	/**
	 * Returns <code>true</code> if the length has been determined by the data returned from
	 * server. If the length is a client side estimation <code>false</code> is returned.
	 *
	 * @returns {boolean}
	 *   If <code>true</true> the length is determined by server side data
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#isLengthFinal
	 * @since 1.37.0
	 */
	// @override
	ODataListBinding.prototype.isLengthFinal = function () {
		// some controls use .bLengthFinal on list binding instead of calling isLengthFinal
		return this.bLengthFinal;
	};

	/**
	 * Merges the given values for "$orderby" and "$filter" into the given map of query options.
	 * Ensures that the original map is left unchanged, but creates a copy only if necessary.
	 *
	 * @param {object} [mQueryOptions]
	 *   The map of query options
	 * @param {string} [sOrderby]
	 *   The new value for the query option "$orderby"
	 * @param {string} [sFilter]
	 *   The new value for the query option "$filter"
	 * @returns {object}
	 *   The merged map of query options
	 *
	 * @private
	 */
	ODataListBinding.prototype.mergeQueryOptions = function (mQueryOptions, sOrderby, sFilter) {
		var mResult;

		function set(sProperty, sValue) {
			if (sValue && (!mQueryOptions || mQueryOptions[sProperty] !== sValue)) {
				if (!mResult) {
					mResult = mQueryOptions ? JSON.parse(JSON.stringify(mQueryOptions)) : {};
				}
				mResult[sProperty] = sValue;
			}
		}

		set("$orderby", sOrderby);
		set("$filter", sFilter);
		return mResult || mQueryOptions;
	};

	/**
	 * @override
	 * @see sap.ui.model.odata.v4.ODataBinding#refreshInternal
	 */
	ODataListBinding.prototype.refreshInternal = function (sGroupId) {
		var that = this;

		this.sRefreshGroupId = sGroupId;
		this.oCachePromise.then(function (oCache) {
			if (oCache) {
				that.mCacheByContext = undefined;
				that.fetchCache(that.oContext);
			}
			that.reset(ChangeReason.Refresh);
			// Skip bindings that have been created via ODataListBinding#create because after
			// refresh the newly created context is gone. Avoid "Failed to drill down..." errors.
			that.oModel.getDependentBindings(that, true).forEach(function (oDependentBinding) {
				// Call refreshInternal with bCheckUpdate = false because property bindings should
				// not check for updates yet, otherwise they will cause a "Failed to drill down..."
				// when the row is no longer part of the collection. They get another update request
				// in createContexts, when the context for the row is reused.
				oDependentBinding.refreshInternal(sGroupId, false);
			});
		});
	};

	/**
	 * Resets the binding's contexts array and its members related to current contexts and length
	 * calculation. All bindings dependent to the header context are requested to check for updates.
	 *
	 * @param {sap.ui.model.ChangeReason} [sChangeReason]
	 *   A change reason; if given, a refresh event with this reason is fired and the next
	 *   getContexts() fires a change event with this reason.
	 *
	 * @private
	 */
	ODataListBinding.prototype.reset = function (sChangeReason) {
		var that = this;

		if (this.aContexts) {
			this.aContexts.forEach(function (oContext) {
				that.mPreviousContextsByPath[oContext.getPath()] = oContext;
			});
		}
		this.aContexts = [];
		// the range for getCurrentContexts
		this.iCurrentBegin = this.iCurrentEnd = 0;
		// upper boundary for server-side list length (based on observations so far)
		// Note: Non-transient created entities are included and exist twice: with index -1 and
		// with some unknown (server-side) index i >= 0!
		// Thus it is OK to compare this.aContexts.length and this.iMaxLength!
		// BUT: the binding's length can be one greater than this.iMaxLength due to index -1!
		this.iMaxLength = Infinity;
		this.bLengthFinal = false;
		if (sChangeReason) {
			this.sChangeReason = sChangeReason;
			this._fireRefresh({reason : sChangeReason});
		}
		// Update after the refresh event, otherwise $count is fetched before the request
		if (this.getHeaderContext()) {
			this.oModel.getDependentBindings(this.oHeaderContext).forEach(function (oBinding) {
				oBinding.checkUpdate();
			});
		}
	};

	/**
	 * Sets the context and resets the cached contexts of the list items.
	 *
	 * @param {sap.ui.model.Context} oContext
	 *   The context object
	 * @throws {Error}
	 *   For relative bindings containing created entities
	 *
	 * @private
	 * @see sap.ui.model.Binding#setContext
	 */
	// @override
	ODataListBinding.prototype.setContext = function (oContext) {
		var sResolvedPath;

		if (this.oContext !== oContext) {
			if (this.bRelative) {
				// Keep the header context even if we lose the parent context, so that the header
				// context remains unchanged if the parent context is temporarily dropped during a
				// refresh.
				if (this.aContexts && this.aContexts[-1]) {
					// to allow switching the context for new created entities (transient or not)
					// we first have to implement a store/restore mechanism for the -1 entry
					throw new Error("setContext on relative binding is forbidden if created " +
						"entity exists: " + this);
				}
				this.reset();
				this.fetchCache(oContext);
				if (oContext) {
					sResolvedPath = this.oModel.resolve(this.sPath, oContext);
					if (this.oHeaderContext && this.oHeaderContext.getPath() !== sResolvedPath) {
						this.oHeaderContext.destroy();
						this.oHeaderContext = null;
					}
					if (!this.oHeaderContext) {
						this.oHeaderContext = Context.create(this.oModel, this, sResolvedPath);
					}
				}
				// call Binding#setContext because of data state etc.; fires "change"
				Binding.prototype.setContext.call(this, oContext);
			} else {
				// remember context even if no "change" fired
				this.oContext = oContext;
			}
		}
	};

	/**
	 * Sort the entries represented by this list binding according to the given sorters.
	 * The sorters are stored at this list binding and they are used for each following data
	 * request.
	 *
	 * If there are pending changes an error is thrown. Use {@link #hasPendingChanges} to check if
	 * there are pending changes. If there are changes, call
	 * {@link sap.ui.model.odata.v4.ODataModel#submitBatch} to submit the changes or
	 * {@link sap.ui.model.odata.v4.ODataModel#resetChanges} to reset the changes before calling
	 * {@link #sort}.
	 *
	 * @param {sap.ui.model.Sorter | sap.ui.model.Sorter[]} [vSorters]
	 *   The dynamic sorters to be used; they replace the dynamic sorters given in
	 *   {@link sap.ui.model.odata.v4.ODataModel#bindList}.
	 *   Static sorters, as defined in the '$orderby' binding parameter, are always executed after
	 *   the dynamic sorters.
	 * @returns {sap.ui.model.odata.v4.ODataListBinding}
	 *   <code>this</code> to facilitate method chaining
	 * @throws {Error}
	 *   If there are pending changes or if an unsupported operation mode is used (see
	 *   {@link sap.ui.model.odata.v4.ODataModel#bindList}).
	 *
	 * @public
	 * @see sap.ui.model.ListBinding#sort
	 * @since 1.39.0
	 */
	ODataListBinding.prototype.sort = function (vSorters) {
		if (this.sOperationMode !== OperationMode.Server) {
			throw new Error("Operation mode has to be sap.ui.model.odata.OperationMode.Server");
		}

		if (this.hasPendingChanges()) {
			throw new Error("Cannot sort due to pending changes");
		}

		this.aSorters = _Helper.toArray(vSorters);
		this.mCacheByContext = undefined;
		this.fetchCache(this.oContext);
		this.reset(ChangeReason.Sort);
		return this;
	};

	/**
	 * Returns a string representation of this object including the binding path. If the binding is
	 * relative, the parent path is also given, separated by a '|'.
	 *
	 * @return {string} A string description of this binding
	 * @public
	 * @since 1.37.0
	 */
	ODataListBinding.prototype.toString = function () {
		return sClassName + ": " + (this.bRelative ? this.oContext + "|" : "") + this.sPath;
	};

	/**
	 * Updates the binding's "$apply" parameter based on the given analytical information as
	 * "groupby((&lt;dimension_1,...,dimension_N>),aggregate(&lt;measure_1,...,measure_M>))" where
	 * the "aggregate" part is only present if measures are given.
	 *
	 * Analytical information is the mapping of UI columns to properties in the bound OData entity
	 * set. Every column object contains at least the <code>name</code> of the bound property.
	 * <ol>
	 *   <li>A column bound to a dimension property has further boolean properties:
	 *     <ul>
	 *       <li><code>grouped</code>: its presence is used to detect a dimension</li>
	 *       <li><code>inResult</code> and <code>visible</code>: the dimension is ignored unless at
	 *         least one of these is <code>true</code></li>
	 *     </ul>
	 *   </li>
	 *   <li>A column bound to a measure property has further boolean properties:
	 *     <ul>
	 *       <li><code>total</code>: its presence is used to detect a measure</li>
	 *     </ul>
	 *   </li>
	 * </ol>
	 *
	 * @param {object[]} aColumns
	 *   An array with objects holding the analytical information for every column, from left to
	 *   right
	 * @throws {Error} In case a column is neither a dimension nor a measure, or both a dimension
	 *   and a measure
	 *
	 * @protected
	 * @see sap.ui.model.analytics.AnalyticalBinding#updateAnalyticalInfo
	 * @see #changeParameters
	 * @since 1.53.0
	 */
	ODataListBinding.prototype.updateAnalyticalInfo = function (aColumns) {
		var aAggregate = [],
			aGroupBy = [];

		aColumns.forEach(function (oColumn) {
			if ("total" in oColumn) { // measure
				if ("grouped" in oColumn) {
					throw new Error("Both dimension and measure: " + oColumn.name);
				}
				aAggregate.push(oColumn.name);
			} else if ("grouped" in oColumn) { // dimension
				if (oColumn.inResult || oColumn.visible) {
					aGroupBy.push(oColumn.name);
				}
			} else {
				throw new Error("Neither dimension nor measure: " + oColumn.name);
			}
		});

		this.changeParameters({$apply : "groupby((" + aGroupBy.join(",")
			+ (aAggregate.length ? "),aggregate(" + aAggregate.join(",") + "))" : "))")});
	};

	return ODataListBinding;
});
