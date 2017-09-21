/**
 * Utility URL builder
 */
var UriBuilder = function UriBuilder(){
	this.pathSegments = [];
	return this;
}
UriBuilder.prototype.path = function(_pathSegments){
	if(!Array.isArray(_pathSegments))
		_pathSegments = [_pathSegments];
	_pathSegments = _pathSegments.filter(function(segment){
			return segment;
		})
		.map(function(segment){
			if(segment.length){
				if(segment.charAt(segment.length-1) ==='/')
					segment = segment.substring(0, segment.length-2);
				segment = encodeURIComponent(segment);
			} 
			return segment;
		});
	this.pathSegments = this.pathSegments.concat(_pathSegments);
	return this;
}
UriBuilder.prototype.build = function(){
	var uriPath = '/'+this.pathSegments.join('/');
	return uriPath;
}

/**
 * Workspace Service API delegate
 */
var WorkspaceService = function($http, workspaceManagerServiceUrl, workspacesServiceUrl, treeCfg){

	this.workspaceManagerServiceUrl = workspaceManagerServiceUrl;
	this.workspacesServiceUrl = workspacesServiceUrl;
	this.typeMapping = treeCfg['types'];
	this.$http = $http;
	
	this.newFileName = function(name, type, siblingFilenames){
		type = type || 'default';
		//check for custom new file name template in the global configuration
		if(type && this.typeMapping[type] && this.typeMapping[type].template_new_name){
			var nameIncrementRegex = this.typeMapping[type].name_increment_regex;
			siblingFilenames = siblingFilenames || [];
			var suffix = nextIncrementSegment(siblingFilenames, name, nameIncrementRegex);
			suffix = suffix < 0 ? " " : suffix;
			var parameters = {
				"{name}": name || 'file',
				"{ext}": this.typeMapping[type].ext,
				"{increment}" : "-"+suffix
			}
			var tmpl = this.typeMapping[type].template_new_name;
			var regex = new RegExp(Object.keys(parameters).join('|'), 'g');
			var fName = tmpl.replace(regex, function(m) {
				return parameters[m]!==undefined?parameters[m]:m;
			});
			name = fName.trim();
		} 
		return name;
	}
			
	var startsWith = function (stringToTest, prefixToTest){
		var startsWithRegEx = new RegExp('^'+prefixToTest);
		var matches = stringToTest.match(startsWithRegEx);
		return matches != null && matches.length > 0;
	}
	
	var strictInt = function(value) {
	  if (/^(\-|\+)?([0-9]+|Infinity)$/.test(value))
		return Number(value);
	  return NaN;
	}
	
	var toInt = function(value){
		if(value ===undefined)
			return;
		var _result = value.trim();
		_result = strictInt(_result);
		if(isNaN(_result))
			_result = undefined;
		return _result;
	}
	
	//processes an array of sibling string filenames to calculate the next incrmeent suffix segment
	var nextIncrementSegment = function(filenames, filenameToMatch, nameIncrementRegex){
		var maxIncrement = filenames.map(function(siblingFilename){
			//find out incremented file name matches (such as {file-name} {i}.{extension} or {file-name}-{i}.{extension})
			var incr = -2;
			//in case we have a regex configured to find out the increment direclty, use it
			if(nameIncrementRegex){
				var regex = new Regex(nameIncrementRegex);
				var result = siblingFilename.match(regex);
				if(result!==null){
					incr = toInt(result[0]);
				}
			} else {
				//try heuristics
				var regex = /(.*?)(\.[^.]*$|$)/;
				var siblingTextSegments = siblingFilename.match(regex);//matches filename and extension segments of a filename
				var siblingTextFileName = siblingTextSegments[1];
				var siblingTextExtension = siblingTextSegments[2];
				var nodeTextSegments = filenameToMatch.match(regex);
				var nodeTextFileName = nodeTextSegments[1];
				var nodeTextExtension = nodeTextSegments[2];
				if(siblingTextExtension === nodeTextExtension){
					if(siblingTextFileName === nodeTextFileName)
						return -1;
					if(startsWith(siblingTextFileName, nodeTextFileName)){
						//try to figure out the increment segment from the name part. Starting backwards, exepcts that the increment is the last numeric segment in the name
						var _inc = "";
						for(var i=siblingTextFileName.length-1; i>-1; i-- ){
							var code = siblingTextFileName.charCodeAt(i);
							if(code<48 || code>57)//decimal numbers only
								break;
							_inc = siblingTextFileName[i] +_inc;
						}
						if(_inc){
							incr = toInt(_inc);
						}	
					}
				}
			}		
			return incr;
		}).sort(function(a, b){
			return a - b;
		}).pop();
		return ++maxIncrement;
	}
};
WorkspaceService.prototype.load = function(wsResourcePath){
	var url = new UriBuilder().path(this.workspacesServiceUrl.split('/')).path(wsResourcePath.split('/')).build();
	return this.$http.get(url, {headers: { 'describe': 'application/json'}})
			.then(function(response){
				return response.data;
			});
}
WorkspaceService.prototype.listWorkspaceNames = function(){
	var url = new UriBuilder().path(this.workspacesServiceUrl.split('/')).build();
	return this.$http.get(url)
			.then(function(response){
				return response.data;
			});
}


/**
 * Workspace Tree Adapter mediating the workspace service REST api and the jst tree componet working with it
 */
var WorkspaceTreeAdapter = function(treeConfig, workspaceSvc, gitService, $messageHub){
	this.treeConfig = treeConfig;
	this.gitService = gitService;
	this.$messageHub = $messageHub;
	this.workspaceSvc = workspaceSvc;

	this._buildTreeNode = function(f){
		var children = [];
		if(f.type=='folder' || f.type=='project'){
			children = f.folders.map(this._buildTreeNode.bind(this));
			var _files = f.files.map(this._buildTreeNode.bind(this))
			children = children.concat(_files);
		}
		f.label = f.name;
		return {
			"text": f.name,
			"children": children,
			"type": f.type,
			"_file": f
		}
	};
	
	this._fnr = function (node, replacement){
		if(node.children){
			var done;
			node.children = node.children.map(function(c){
				if(!done && c._file.path === replacement._file.path){
					done = true;
					return replacement;
				}
				return c;
			});
			if(done)
				return true;
			node.children.forEach(function(c){
				return this._fnr(c, replacement);
			}.bind(this));
		}
		return;
	};
};

WorkspaceTreeAdapter.prototype.init = function(containerEl, workspaceName){
	this.containerEl = containerEl;
	this.workspaceName = workspaceName;
	
	var self = this;
	var jstree = this.containerEl.jstree(this.treeConfig);
	
	//subscribe event listeners
	jstree.on('select_node.jstree', function (e, data) {
		this.clickNode(this.jstree.get_node(data.node));
	}.bind(this))
	.on('dblclick.jstree', function (evt) {
		this.dblClickNode(this.jstree.get_node(evt.target))
	}.bind(this))
	.on('open_node.jstree', function(evt, data) {
		if (data.node.type !== 'project')
			data.instance.set_icon(data.node, 'fa fa-folder-open-o');
	})
	.on('close_node.jstree', function(evt, data) {
		if (data.node.type !== 'project')
			data.instance.set_icon(data.node, 'fa fa-folder-o');
	})
	.on('delete_node.jstree', function (e, data) {
		this.deleteNode(data.node)
	}.bind(this))
	.on('jstree.workspace.pull', function (e, data) {		
		this.pull(data);
	}.bind(this))
	.on('jstree.workspace.push', function (e, data) {		
		this.pull(data);
	}.bind(this))
	.on('jstree.workspace.reset', function (e, data) {		
		this.pull(data);
	}.bind(this));
	
	this.jstree = $.jstree.reference(jstree);	
	return this;
};

WorkspaceTreeAdapter.prototype.dblClickNode = function(node){
	var type = node.original.type;
	if(['folder','project'].indexOf(type)<0)
		this.$messageHub.announceFileOpen(node.original._file);
}
WorkspaceTreeAdapter.prototype.clickNode = function(node){
	var type = node.original.type;
	this.$messageHub.announceFileSelected(node.original._file);
};
WorkspaceTreeAdapter.prototype.raw = function(){
	return this.jstree;
}
WorkspaceTreeAdapter.prototype.refresh = function(node, keepState){
	//TODO: This is reliable but a bit intrusive. Find out a more subtle way to update on demand
	var resourcepath;
	if(node){
		resourcepath = node.original._file.path;
	} else {
		resourcepath = this.workspaceName;
	}
	return this.workspaceSvc.load(resourcepath)
			.then(function(_data){
				var data = [];
				if(_data.type == 'workspace'){
					data = _data.projects;
				} else if(_data.type == 'folder' || _data.type == 'project'){
					data = [_data];
				}
				
				data = data.map(this._buildTreeNode.bind(this));
				
				if(!this.jstree.settings.core.data || _data.type === 'workspace')
					this.jstree.settings.core.data = data;
				else{
					//find and replace the loaded node
					var self  = this;
					this.jstree.settings.core.data = this.jstree.settings.core.data.map(function(node){
						data.forEach(function(_node, replacement){
							if(self._fnr(_node, replacement))
								return;
						}.bind(self, node));
						return node;
					});
				}
				if(!keepState)
					this.jstree.refresh();
			}.bind(this));
};
WorkspaceTreeAdapter.prototype.pull = function(resource){
	return this.gitService.pull(resource.path)
	.then(function(){
		return this.$messageHub.announcePublish(resource);
	}.bind(this));
};
WorkspaceTreeAdapter.prototype.push = function(resource){
	return this.gitService.push(resource.path)
	.then(function(){
		return this.$messageHub.announcePublish(resource);
	}.bind(this));
};
WorkspaceTreeAdapter.prototype.reset = function(resource){
	return this.gitService.reset(resource.path)
	.then(function(){
		return this.$messageHub.announcePublish(resource);
	}.bind(this));
};



/**
 * Git Service API delegate
 */
var GitService = function($http, gitServiceUrl, treeCfg){
	this.gitServiceUrl = gitServiceUrl;
	this.typeMapping = treeCfg['types'];
	this.$http = $http;
}
GitService.prototype.cloneProject = function(workspace, repository, wsTree){
	var url = new UriBuilder().path(this.gitServiceUrl.split('/')).path(workspace).path("clone").build();
	return this.$http.post(url, {
			"repository": repository,
			"branch": "master",
			"publish": true})
			.then(function(response){
				wsTree.refresh();
				return response.data;
			});
}
GitService.prototype.pullProject = function(workspace, project, wsTree){
    //
}
GitService.prototype.pushProject = function(workspace, project, wsTree){
    //
}
GitService.prototype.resetProject = function(workspace, project, wsTree){
    //
}

angular.module('workspace.config', [])
	.constant('WS_SVC_URL','/services/v3/ide/workspaces')
	.constant('WS_SVC_MANAGER_URL','/services/v3/ide/workspace')
	.constant('GIT_SVC_URL','/services/v3/ide/git')
	
angular.module('workspace', ['workspace.config', 'ngAnimate', 'ngSanitize', 'ui.bootstrap.modal.dialog'])
.config(['$httpProvider', function($httpProvider) {
	//check if response is error. errors currently are non-json formatted and fail too early
	$httpProvider.defaults.transformResponse.unshift(function(data, headersGetter, status){
		if(status>399){
			data = {
				"error": data
			}
			data = JSON.stringify(data);
		}
		return data;
	});
}])
.factory('$messageHub', [function(){
	var messageHub = new FramesMessageHub();	
	var message = function(evtName, data){
		messageHub.post({data: data}, 'workspace.' + evtName);
	};
	var announceFileSelected = function(fileDescriptor){
		this.message('file.selected', fileDescriptor);
	};
	var announceFileCreated = function(fileDescriptor){
		this.message('file.created', fileDescriptor);
	};
	var announceFileOpen = function(fileDescriptor){
		this.message('file.open', fileDescriptor);
	};
	var announcePull = function(fileDescriptor){
		this.message('file.pull', fileDescriptor);
	};
	return {
		message: message,
		announceFileSelected: announceFileSelected,
		announceFileCreated: announceFileCreated,
		announceFileOpen: announceFileOpen,
		announcePull: announcePull
	};
}])
.factory('$treeConfig', [function(){
	return {
		'core' : {
			'themes': {
				"name": "default",
				"responsive": false,
				"dots": false,
				"icons": true,
				'variant' : 'small',
				'stripes' : true
			}
		},
		'plugins': ['state','dnd','sort','types','contextmenu','unique'],
		"types": {
			"default": {
				"icon": "fa fa-file-o",
				"default_name": "file",
				"template_new_name": "{name}{counter}"
			},
			'file': {
				"valid_children": []
			},
			'folder': {
				"default_name": "folder",
				'icon': "fa fa-folder-o"
			},
			"project": {
				"icon": "fa fa-pencil-square-o"
			}
		},
		"contextmenu": {
			"items" : function(node) {
				var ctxmenu = {};
				ctxmenu.pull = {
					"separator_before": false,
					"label": "Pull",
					"action": function(data){
						var tree = $.jstree.reference(data.reference);
						var node = tree.get_node(data.reference);
						tree.element.trigger('jstree.workspace.pull', [node.original._file]);
					}.bind(this)
				};
				ctxmenu.push = {
					"separator_before": false,
					"label": "Push",
					"action": function(data){
						var tree = $.jstree.reference(data.reference);
						var node = tree.get_node(data.reference);
						tree.element.trigger('jstree.workspace.push', [node.original._file]);
					}.bind(this)
				};
				ctxmenu.reset = {
					"separator_before": false,
					"label": "Reset",
					"action": function(data){
						var tree = $.jstree.reference(data.reference);
						var node = tree.get_node(data.reference);
						tree.element.trigger('jstree.workspace.reset', [node.original._file]);
					}.bind(this)
				};
				
				return ctxmenu;
			}
		}
	}
}])
.factory('gitService', ['$http', 'GIT_SVC_URL', '$treeConfig', function($http, WS_SVC_URL, $treeConfig){
	return new GitService($http, WS_SVC_URL, $treeConfig);
}])
.factory('workspaceService', ['$http', 'WS_SVC_MANAGER_URL', 'WS_SVC_URL', '$treeConfig', function($http, WS_SVC_MANAGER_URL, WS_SVC_URL, $treeConfig){
	return new WorkspaceService($http, WS_SVC_MANAGER_URL, WS_SVC_URL, $treeConfig);
}])
.factory('workspaceTreeAdapter', ['$treeConfig', 'workspaceService', 'gitService', '$messageHub', function($treeConfig, WorkspaceService, GitService, $messageHub){
	return new WorkspaceTreeAdapter($treeConfig, WorkspaceService, GitService, $messageHub);
}])
.controller('WorkspaceController', ['workspaceService', 'workspaceTreeAdapter', 'gitService', function (workspaceService, workspaceTreeAdapter, gitService) {

	this.wsTree;
	this.workspaces;
	this.selectedWs;
	
	this.clone = {};
	this.push = {};
	this.pull = {};
	this.reset = {};
	this.share = {};
	
	workspaceService.listWorkspaceNames()
		.then(function(workspaceNames) {
			this.workspaces = workspaceNames;
			if(this.workspaces[0]) {
				this.selectedWs = this.workspaces[0];
				this.workspaceSelected()					
			} 
		}.bind(this));
	
	this.workspaceSelected = function(){
		if (this.wsTree) {
			this.wsTree.workspaceName = this.selectedWs;
			this.wsTree.refresh();
			return;
		}
		this.wsTree = workspaceTreeAdapter.init($('.workspace'), this.selectedWs);
		if(!workspaceService.typeMapping)
			workspaceService.typeMapping = $treeConfig[types];
		this.wsTree.refresh();
	};
	
	this.openClone = function() {
		this.showClone = true;
	};

	this.okClone = function() {
		this.showClone = false;
		if (this.clone.url) {
			gitService.cloneProject(this.selectedWs, this.clone.url, this.wsTree);
		}
	};

	this.cancelClone = function() {
		this.showClone = false;
	};

}]);