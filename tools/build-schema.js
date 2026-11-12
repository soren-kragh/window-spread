// Generates extension/window-spread@soren-kragh/settings-schema.json from the engine's DEFAULTS,
// so the settings dialog's defaults can't drift from the engine's.
//   Run from anywhere:  node tools/build-schema.js
// Edit this file to change settings labels, ranges, tooltips or the page layout; edit
// DEFAULTS in spreadLayout.js to change default values. Then run it and copy the extension
// folder to Cinnamon again.
const path=require('path');
const EXT=path.join(__dirname,'..','extension','window-spread@soren-kragh');
const SL=require(path.join(EXT,'spreadLayout.js'));
const D=SL.DEFAULTS;
const sec=(description,dependency)=>({type:'section',description,...(dependency?{dependency}:{})});
const scale=(group,key,description,min,max,step,tooltip,extra={})=>({type:'scale',default:D[group][key],min,max,step,description,tooltip,...extra});
const spin=(group,key,description,min,max,step,units,tooltip,extra={})=>({type:'spinbutton',default:D[group][key],min,max,step,units,description,tooltip,...extra});
const sw=(group,key,description,tooltip,extra={})=>({type:'switch',default:D[group][key],description,tooltip,...extra});
const combo=(group,key,description,options,tooltip,extra={})=>({type:'combobox',default:D[group][key],description,options,tooltip,...extra});
const schema={
  'algorithm':{type:'combobox',default:'anneal',description:'Layout algorithm',options:{'Optimizer':'anneal','Push apart, then scale':'natural','Ordered rows':'rows','Equal grid':'grid'},
    tooltip:'How thumbnails are arranged. All algorithms use only window positions and sizes, never stacking order or focus.'},
  'use-cache':{type:'switch',default:true,description:'Reuse the previous layout when nothing has changed',tooltip:'Keeps both views quick by reusing the previous arrangement when nothing has changed; the result is the same either way. Leave this on. Switching it off is only useful for troubleshooting.'},
  'restore-defaults':{type:'button',description:'Restore all settings to their defaults',callback:'restoreDefaults',
    tooltip:'Sets every setting on this page back to its default value.'},
  'debug-log':{type:'switch',default:false,description:'Write diagnostics to the log',tooltip:'Writes information for troubleshooting to the log. View it in Looking Glass (Alt+F2, then lg) under Log.'},

  'margin':spin('common','margin','Margin around the screen edge',0,200,4,'px','Empty border kept around the edge of the screen.'),
  'spacing':spin('common','spacing','Gap between thumbnails',0,80,2,'px','Space between thumbnails.'),
  'fidelity':scale('common','fidelity','Size fidelity',0,1,0.05,'1 keeps true size ratios between windows; 0 gives every thumbnail the same area; values in between compress size differences. Not used by the equal grid.',{dependency:'algorithm!=grid'}),
  'max-scale':scale('common','maxScale','Largest thumbnail scale',0.2,1,0.05,'Largest size of a thumbnail compared with its real window; 1 means real size.'),
  'centered':sw('common','centered','Always center the arrangement','When off, the arrangement is moved toward where the real windows are, as far as the screen allows. Not used by the equal grid.',{dependency:'algorithm!=grid'}),
  'fill':sw('common','fill','Fill gaps afterwards','Lets thumbnails grow into free space after layout. Uses space better but makes sizes less faithful. Not used by the equal grid.',{dependency:'algorithm!=grid'}),
  'grow-limit':scale('common','growLimit','Fill gaps: maximum growth',1,3,0.1,'The most a thumbnail may grow while filling gaps.',{dependency:'fill'}),

  'w-scale':scale('scoring','wScale','Thumbnail size',0,5,0.1,'How much bigger thumbnails count.'),
  'w-disp':scale('scoring','wDisp','Stay in place',0,5,0.1,'Penalty for thumbnails far from where their real window is.'),
  'w-rel':scale('scoring','wRel','Keep relations',0,5,0.1,'Penalty for windows changing how they sit relative to each other.'),
  'rel-mode':combo('scoring','relMode','Relations method',{'Order (left/right, above/below)':'order','Direction (angles)':'direction'},'Order only cares whether windows swap sides; Direction compares the angles between windows and is stricter.'),
  'rel-near':scale('scoring','relNear','Neighbor focus',0,1,0.05,'How much more nearby windows matter than distant ones.',{dependency:'rel-mode=direction'}),

  'anneal-iterations':spin('anneal','iterations','Effort (moves)',1000,200000,1000,'','Total random moves, shared by all parallel starts. More is better but slower.'),
  'anneal-restarts':spin('anneal','restarts','Parallel starts',1,16,1,'','Independent searches racing each other.'),
  'anneal-checkpoint':scale('anneal','checkpoint','First checkpoint',0.05,0.95,0.05,'How far through the search the first weak starts are dropped.'),
  'anneal-temp':scale('anneal','temp','Temperature',0.005,0.5,0.005,'Willingness to accept worse arrangements early in the search.'),
  'anneal-start-from':combo('anneal','startFrom','Start from',{'Push-apart':'push','Ordered rows':'rows','Equal grid':'grid','Real positions':'none','Mixed (one per start)':'mixed'},'Where the search begins. Mixed gives the parallel starts different starting points.'),
  'anneal-seed':spin('anneal','seed','Random seed',1,100,1,'','Same seed and same windows always give the same layout.'),
  'anneal-bailout':sw('anneal','bailout','Drop weak starts','Stops the worse half of the starts at each checkpoint, focusing effort on the promising ones.'),
  'anneal-polish':sw('anneal','polish','Polish the result','Final small moves into free space that improve the score.'),

  'natural-iterations':spin('natural','iterations','Effort (passes)',10,5000,10,'','Maximum push-apart passes.'),
  'natural-step':scale('natural','step','Push strength',0.05,1,0.05,'How far each push moves an overlapping pair.'),
  'natural-aspect':scale('natural','aspect','Match screen shape',0,1,0.05,'Bias pushes toward the screen\'s shape.'),
  'natural-polish':sw('natural','polish','Polish the result','Final small moves into free space that improve the score.'),

  // A drop-down rather than a spin button: Cinnamon's settings dialog leaves a spin button blank when
  // its value is 0 (it skips setting a value equal to the new widget's initial 0), and 0 means automatic.
  'scale-enabled':{type:'switch',default:true,description:'Enable',
    tooltip:'When off, Cinnamon arranges Show all windows itself.'},
  'expo-enabled':{type:'switch',default:true,description:'Enable',
    tooltip:'When off, Cinnamon arranges the windows in Show all workspaces itself.'},
  'expo-algorithm':{type:'combobox',default:'grid',description:'Layout algorithm',options:{'Optimizer':'anneal','Push apart, then scale':'natural','Ordered rows':'rows','Equal grid':'grid'},
    tooltip:'How windows are arranged inside each workspace. Equal grid makes even small windows reasonably big, which helps in the small workspace previews.'},
  'expo-margin':{type:'spinbutton',default:14,min:0,max:200,step:2,units:'px',description:'Margin around the edge',
    tooltip:'Empty border inside each workspace preview.'},
  'expo-spacing':{type:'spinbutton',default:14,min:0,max:80,step:2,units:'px',description:'Gap between windows',
    tooltip:'Space between windows inside each workspace preview.'},
  // Expo's own copies of the layout settings below; same defaults (engine DEFAULTS), same meaning.
  'expo-fidelity':scale('common','fidelity','Size fidelity',0,1,0.05,'1 keeps true size ratios between windows; 0 gives every thumbnail the same area; values in between compress size differences. Lower values make small windows easier to see in the small previews. Not used by the equal grid.',{dependency:'expo-algorithm!=grid'}),
  'expo-max-scale':scale('common','maxScale','Largest thumbnail scale',0.2,1,0.05,'Largest size of a thumbnail compared with its real window; 1 means real size.'),
  'expo-centered':sw('common','centered','Always center the arrangement','When off, the arrangement is moved toward where the real windows are, as far as the preview allows. Not used by the equal grid.',{dependency:'expo-algorithm!=grid'}),
  'expo-fill':sw('common','fill','Fill gaps afterwards','Lets thumbnails grow into free space after layout. Uses space better but makes sizes less faithful. Not used by the equal grid.',{dependency:'expo-algorithm!=grid'}),
  'expo-grow-limit':scale('common','growLimit','Fill gaps: maximum growth',1,3,0.1,'The most a thumbnail may grow while filling gaps.',{dependency:'expo-fill'}),

  'rows-count':combo('rows','rows','Number of rows',{'Automatic':0,'1 row':1,'2 rows':2,'3 rows':3,'4 rows':4,'5 rows':5,'6 rows':6,'7 rows':7,'8 rows':8},
    'Automatic tries every possible number of rows and uses the one that gives the biggest thumbnails.'),
};
for(const v of Object.values(schema)) if(v.units==='') delete v.units;
// Pages (tabs) and sections of the settings window. Short pages, so the window never needs
// scrolling: scrolling over a slider changes the slider instead (python3-xapp's Range widget).
const layout={type:'layout',pages:['page-general','page-layout','page-expo','page-scoring','page-optimizer','page-push'],
  'page-general':{type:'page',title:'General',sections:['sec-general','sec-defaults']},
  'page-layout':{type:'page',title:'Show all windows',sections:['sec-scale-enable','sec-layout']},
  'page-expo':{type:'page',title:'Show all workspaces',sections:['sec-expo-enable','sec-expo']},
  'page-scoring':{type:'page',title:'Scoring',sections:['sec-scoring']},
  'page-optimizer':{type:'page',title:'Optimizer',sections:['sec-optimizer']},
  'page-push':{type:'page',title:'Push-apart & rows',sections:['sec-natural','sec-rows']},
  'sec-general':{type:'section',title:'General (both views)',keys:['use-cache','debug-log']},
  'sec-defaults':{type:'section',title:'Defaults',keys:['restore-defaults']},
  // Each view: the Enable switch in its own section, everything else in a section that is hidden
  // while the switch is off (settings inside can still have their own conditions).
  'sec-scale-enable':{type:'section',title:'Show all windows (Scale)',keys:['scale-enabled']},
  'sec-layout':{type:'section',title:'Arrangement',dependency:'scale-enabled',keys:['algorithm','margin','spacing','fidelity','max-scale','centered','fill','grow-limit']},
  'sec-scoring':{type:'section',title:'What makes a good layout',keys:['w-scale','w-disp','w-rel','rel-mode','rel-near']},
  'sec-optimizer':{type:'section',title:'Optimizer settings',keys:['anneal-iterations','anneal-restarts','anneal-checkpoint','anneal-temp','anneal-start-from','anneal-seed','anneal-bailout','anneal-polish']},
  'sec-natural':{type:'section',title:'Push-apart (also a starting point for the optimizer)',keys:['natural-iterations','natural-step','natural-aspect','natural-polish']},
  'sec-rows':{type:'section',title:'Ordered rows (also a starting point for the optimizer)',keys:['rows-count']},
  'sec-expo-enable':{type:'section',title:'Show all workspaces (Expo)',keys:['expo-enabled']},
  'sec-expo':{type:'section',title:'Arrangement',dependency:'expo-enabled',keys:['expo-algorithm','expo-margin','expo-spacing','expo-fidelity','expo-max-scale','expo-centered','expo-fill','expo-grow-limit']}};
const ordered={layout}; // the layout must be the first entry
for(const [k,v] of Object.entries(schema)) ordered[k]=v;
for(const k of Object.keys(schema)) delete schema[k];
Object.assign(schema,ordered);
const text=JSON.stringify(schema,null,2)+'\n';
if(require.main===module){
  require('fs').writeFileSync(path.join(EXT,'settings-schema.json'),text);
  console.log('settings-schema.json written: '+Object.keys(schema).length+' entries');
}
module.exports={schema,text};
