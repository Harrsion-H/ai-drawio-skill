/**
 * Copyright (c) 2019-2024, JGraph Holdings Ltd
 */
/**
 * Class: mxElkLayout
 *
 * Extends <mxGraphLayout> to implement ELK (Eclipse Layout Kernel) algorithms.
 * Requires elk.bundled.js to be loaded before use.
 *
 * Supported algorithms: layered, mrtree, radial, force, stress, disco, rectpacking
 *
 * Example:
 *
 * (code)
 * var layout = new mxElkLayout(graph);
 * layout.algorithm = 'layered';
 * layout.direction = 'RIGHT';
 * layout.executeAsync(graph.getDefaultParent()).then(function() {
 *   console.log('Layout complete');
 * });
 * (end)
 */
function mxElkLayout(graph, options)
{
	mxGraphLayout.call(this, graph);
	this.options = options || {};
};

/**
 * Extends mxGraphLayout.
 */
mxElkLayout.prototype = new mxGraphLayout();
mxElkLayout.prototype.constructor = mxElkLayout;

/**
 * Variable: algorithm
 *
 * ELK algorithm to use. Default is 'layered'.
 * Options: layered, mrtree, radial, force, stress, disco, rectpacking, sporeOverlap
 */
mxElkLayout.prototype.algorithm = 'layered';

/**
 * Variable: direction
 *
 * Layout direction. Default is 'DOWN'.
 * Options: DOWN, UP, RIGHT, LEFT (not all algorithms support this)
 */
mxElkLayout.prototype.direction = 'DOWN';

/**
 * Variable: nodeSpacing
 *
 * Minimum spacing between nodes. Default is 20.
 */
mxElkLayout.prototype.nodeSpacing = 20;

/**
 * Variable: rankSpacing
 *
 * Spacing between layers/ranks (layered algorithm). Default is 50.
 */
mxElkLayout.prototype.rankSpacing = 50;

/**
 * Variable: edgeSpacing
 *
 * Spacing between parallel edges. Default is 10.
 */
mxElkLayout.prototype.edgeSpacing = 10;

/**
 * Variable: edgeRouting
 *
 * Edge routing strategy for layered algorithm. Default is 'ORTHOGONAL'.
 * Options: UNDEFINED, POLYLINE, ORTHOGONAL, SPLINES
 */
mxElkLayout.prototype.edgeRouting = 'ORTHOGONAL';

/**
 * Variable: resetEdges
 *
 * Whether to reset edge control points before layout. Default is true.
 */
mxElkLayout.prototype.resetEdges = true;

/**
 * Function: buildElkGraph
 *
 * Converts the mxGraph cells under <parent> into an ELK JSON graph structure.
 */
mxElkLayout.prototype.buildElkGraph = function(parent)
{
	var graph = this.graph;
	var model = graph.getModel();
	var vertices = graph.getChildCells(parent, true, false);
	var edges = graph.getChildCells(parent, false, true);

	var elkNodes = [];
	var nodeIds = {};
	var scale = graph.view.scale;

	for (var i = 0; i < vertices.length; i++)
	{
		var cell = vertices[i];

		if (this.isVertexIgnored(cell)) continue;

		var geo = model.getGeometry(cell);
		if (geo == null) continue;

		// Skip edge labels — they are vertices with relative geometry attached
		// to an edge, not standalone nodes, and must not appear as ELK nodes.
		if (geo.relative) continue;

		// Skip invisible cells.
		if (!graph.isCellVisible(cell)) continue;

		// Use the view state for dimensions so that auto-resizing containers
		// (swimlanes, groups) report their actual rendered size to ELK.
		var state = graph.view.getState(cell);
		var w = state != null ? state.width / scale : (geo.width || 120);
		var h = state != null ? state.height / scale : (geo.height || 60);

		// Non-moveable (locked) cells are included so ELK routes around them,
		// but flagged with a fixed position constraint so ELK does not move them.
		var elkNode = {
			id: cell.id,
			width: Math.max(1, w),
			height: Math.max(1, h)
		};

		if (!graph.isCellMovable(cell))
		{
			elkNode.x = geo.x || 0;
			elkNode.y = geo.y || 0;
			elkNode.layoutOptions = {'elk.position': '(' + (geo.x || 0) + ',' + (geo.y || 0) + ')',
				'elk.nodeConstraint': 'FIXED_POS'};
		}

		elkNodes.push(elkNode);
		nodeIds[cell.id] = true;
	}

	// Returns the id of the nearest ancestor of cell that is an ELK node.
	// This maps edges whose terminals are cells inside a group to the group itself,
	// so grouped cells are treated as a single unit by ELK.
	var elkAncestorId = function(cell)
	{
		var c = cell;
		while (c != null)
		{
			if (nodeIds[c.id]) return c.id;
			c = model.getParent(c);
		}
		return null;
	};

	var elkEdges = [];

	for (var i = 0; i < edges.length; i++)
	{
		var edge = edges[i];
		var source = model.getTerminal(edge, true);
		var target = model.getTerminal(edge, false);

		if (source == null || target == null) continue;

		var srcId = elkAncestorId(source);
		var tgtId = elkAncestorId(target);

		if (srcId == null || tgtId == null) continue;
		if (srcId === tgtId) continue; // internal edge within the same group

		elkEdges.push({
			id: edge.id,
			sources: [srcId],
			targets: [tgtId]
		});
	}

	// Build layout options, merging defaults with user-supplied options
	var layoutOptions = {
		'elk.algorithm': this.algorithm,
		'elk.direction': this.direction,
		'elk.spacing.nodeNode': String(this.nodeSpacing),
		'elk.layered.spacing.nodeNodeBetweenLayers': String(this.rankSpacing),
		'elk.layered.spacing.edgeEdgeBetweenLayers': String(this.edgeSpacing),
		'elk.layered.edgeRouting': this.edgeRouting,
		'elk.mrtree.spacing.nodeNode': String(this.nodeSpacing),
		'elk.radial.compactor': 'NONE',
		'elk.force.iterations': '300'
	};

	for (var key in this.options)
	{
		layoutOptions[key] = this.options[key];
	}

	return {
		id: 'root',
		layoutOptions: layoutOptions,
		children: elkNodes,
		edges: elkEdges
	};
};

/**
 * Function: applyElkLayout
 *
 * Applies ELK layout results (node positions) back to the mxGraph model.
 * Must be called inside a model.beginUpdate/endUpdate block.
 */
mxElkLayout.prototype.applyElkLayout = function(elkGraph)
{
	var graph = this.graph;
	var model = graph.getModel();

	if (!elkGraph.children) return;

	// Build a lookup of ELK node results (needed to normalize connection points)
	var elkNodeMap = {};

	for (var i = 0; i < elkGraph.children.length; i++)
	{
		var elkNode = elkGraph.children[i];
		var cell = model.getCell(elkNode.id);

		if (cell == null) continue;

		var geo = model.getGeometry(cell);
		if (geo == null) continue;

		elkNodeMap[elkNode.id] = elkNode;

		// Do not reposition locked cells — ELK was told their position is fixed.
		if (!graph.isCellMovable(cell)) continue;

		geo = geo.clone();
		geo.x = elkNode.x || 0;
		geo.y = elkNode.y || 0;
		model.setGeometry(cell, geo);
	}

	// Apply ELK edge routing: bend points + connection points from sections
	if (this.resetEdges && elkGraph.edges)
	{
		for (var i = 0; i < elkGraph.edges.length; i++)
		{
			var elkEdge = elkGraph.edges[i];
			var edgeCell = model.getCell(elkEdge.id);

			if (edgeCell == null) continue;

			var geo = model.getGeometry(edgeCell);
			if (geo == null) continue;

			geo = geo.clone();

			// Collect bend points and capture section start/end points
			var points = [];
			var startPoint = null;
			var endPoint = null;

			if (elkEdge.sections && elkEdge.sections.length > 0)
			{
				startPoint = elkEdge.sections[0].startPoint;
				endPoint = elkEdge.sections[elkEdge.sections.length - 1].endPoint;

				for (var s = 0; s < elkEdge.sections.length; s++)
				{
					var section = elkEdge.sections[s];

					if (section.bendPoints)
					{
						for (var b = 0; b < section.bendPoints.length; b++)
						{
							var bp = section.bendPoints[b];
							points.push(new mxPoint(bp.x, bp.y));
						}
					}
				}
			}

			geo.points = points.length > 0 ? points : null;
			model.setGeometry(edgeCell, geo);

			var style = model.getStyle(edgeCell) || '';

			// Disable automatic re-routing so mxGraph draws straight segments through
			// ELK's computed bend points. Setting null only removes the key from the
			// inline style; if the base/named style also defines edgeStyle, mxGraph would
			// still re-route. Using an empty string explicitly overrides the base style.
			style = mxUtils.setStyle(style, 'edgeStyle', '');

			// Set connection points from ELK section start/end normalized to node bounds.
			// Use enough decimal precision so the exit/entry point aligns exactly with
			// the first/last bend point — avoiding the minor diagonal shift that rounding
			// to 2 decimal places would introduce.
			var srcNode = elkEdge.sources && elkNodeMap[elkEdge.sources[0]];

			if (startPoint && srcNode && srcNode.width > 0 && srcNode.height > 0)
			{
				// Clamp to [0,1] — ELK can place a point fractionally outside the node
				// boundary due to floating-point, which would produce an invalid constraint.
				style = mxUtils.setStyle(style, 'exitX',
					Math.min(1, Math.max(0, Math.round((startPoint.x - srcNode.x) / srcNode.width * 10000) / 10000)));
				style = mxUtils.setStyle(style, 'exitY',
					Math.min(1, Math.max(0, Math.round((startPoint.y - srcNode.y) / srcNode.height * 10000) / 10000)));
			}
			else
			{
				style = mxUtils.setStyle(style, 'exitX', null);
				style = mxUtils.setStyle(style, 'exitY', null);
			}

			style = mxUtils.setStyle(style, 'exitDx', null);
			style = mxUtils.setStyle(style, 'exitDy', null);

			var tgtNode = elkEdge.targets && elkNodeMap[elkEdge.targets[0]];

			if (endPoint && tgtNode && tgtNode.width > 0 && tgtNode.height > 0)
			{
				style = mxUtils.setStyle(style, 'entryX',
					Math.min(1, Math.max(0, Math.round((endPoint.x - tgtNode.x) / tgtNode.width * 10000) / 10000)));
				style = mxUtils.setStyle(style, 'entryY',
					Math.min(1, Math.max(0, Math.round((endPoint.y - tgtNode.y) / tgtNode.height * 10000) / 10000)));
			}
			else
			{
				style = mxUtils.setStyle(style, 'entryX', null);
				style = mxUtils.setStyle(style, 'entryY', null);
			}

			style = mxUtils.setStyle(style, 'entryDx', null);
			style = mxUtils.setStyle(style, 'entryDy', null);

			model.setStyle(edgeCell, style);
		}
	}
};

/**
 * Function: executeAsync
 *
 * Performs the ELK layout asynchronously. Returns a Promise that resolves
 * when the layout has been applied to the graph model.
 *
 * Parameters:
 *
 * parent - <mxCell> whose children should be laid out.
 */
mxElkLayout.prototype.executeAsync = function(parent)
{
	if (typeof ELK === 'undefined')
	{
		return Promise.reject(new Error('ELK library not loaded. Include elk.bundled.js before mxElkLayout.js.'));
	}

	var self = this;
	var model = this.graph.getModel();

	// Snapshot the graph structure synchronously before the async call
	var elkGraph = this.buildElkGraph(parent);

	if (elkGraph.children.length === 0)
	{
		return Promise.resolve();
	}

	return new ELK().layout(elkGraph).then(function(result)
	{
		model.beginUpdate();
		try
		{
			self.applyElkLayout(result);
		}
		finally
		{
			model.endUpdate();
		}
	});
};

/**
 * Function: execute
 *
 * Implements <mxGraphLayout.execute>. Starts the async ELK layout.
 * The layout is applied asynchronously after this call returns.
 * Use executeAsync() directly if you need Promise-based control flow.
 *
 * Parameters:
 *
 * parent - <mxCell> whose children should be laid out.
 */
mxElkLayout.prototype.execute = function(parent)
{
	this.executeAsync(parent).catch(function(err)
	{
		if (typeof mxLog !== 'undefined')
		{
			mxLog.warn('mxElkLayout error: ' + err.message);
		}
		else
		{
			console.warn('mxElkLayout error:', err);
		}
	});
};
