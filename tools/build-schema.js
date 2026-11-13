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
const scale=(group,key,description,min,max,step,tooltip,extra={})=>({type:'scale',default:D[group][key],min,max,step,description,tooltip,...extra});
const spin=(group,key,description,min,max,step,units,tooltip,extra={})=>({type:'spinbutton',default:D[group][key],min,max,step,units,description,tooltip,...extra});
const sw=(group,key,description,tooltip,extra={})=>({type:'switch',default:D[group][key],description,tooltip,...extra});
const combo=(group,key,description,options,tooltip,extra={})=>({type:'combobox',default:D[group][key],description,options,tooltip,...extra});
// The algorithm drop-down's tooltip describes every choice: Cinnamon's dialog has one
// tooltip per setting, none per choice. One paragraph per choice rather than bullets:
// GTK wraps tooltip lines at 70 characters without indenting the continuation.
const algoTooltip=(intro,gridNote)=>[
  intro+' None of the algorithms use stacking order or focus.',
  'Optimizer: searches for the best balance of thumbnail size, staying in place and '+
    'keeping relations (Scoring tab). Slowest: from a few milliseconds up to a few '+
    'tens with many windows, when windows have changed.',
  'Push apart: starts where the windows are, pushes overlapping ones '+
    'apart, then scales everything to fit. Fast.',
  'Ordered rows: rows from top to bottom, left to right within a row. Fast.',
  'Equal grid: like Cinnamon\'s own grid, each window shrunk to fit its cell, but in '+
    'the cell nearest to where it really is. Fast.'+gridNote
].join('\n\n');
const schema={
  'algorithm':{type:'combobox',default:'optimizer',description:'Layout algorithm',options:{'Optimizer':'optimizer','Push apart':'push','Ordered rows':'rows','Equal grid':'grid'},
    tooltip:algoTooltip('How thumbnails are arranged.','')},
  'use-cache':{type:'switch',default:true,description:'Layout caching',
    tooltip:'Reuses the previous arrangement of a workspace when its windows and the '+
      'settings haven\'t changed since, which keeps the views quick; the result is the '+
      'same either way. Focusing other windows, changing the stacking order, or '+
      'minimizing and restoring windows don\'t count as changes. Leave this on; '+
      'switching it off is only useful for troubleshooting.'},
  'debug-log':{type:'switch',default:false,description:'Write diagnostics to the log',tooltip:'Writes information for troubleshooting to the log. View it in Looking Glass (Alt+F2, then lg) under Log.'},

  'margin':spin('common','margin','Margin around the screen edge',0,200,4,'px','Empty border kept around the edge of the screen.'),
  'gap':spin('common','gap','Gap between thumbnails',0,80,2,'px','Space between thumbnails.'),
  'fidelity':scale('common','fidelity','Size fidelity',0,1,0.05,'1 keeps true size ratios between windows; 0 gives every thumbnail the same area; values in between compress size differences.',{dependency:'algorithm!=grid'}),
  'max-scale':scale('common','maxScale','Largest thumbnail scale',0.2,1,0.05,'Largest size of a thumbnail compared with its real window; 1 means real size.'),
  'centered':sw('common','centered','Always center the arrangement','When off, the arrangement is moved toward where the real windows are, as far as the screen allows.',{dependency:'algorithm!=grid'}),
  'fill':sw('common','fill','Fill gaps afterwards','Lets thumbnails grow into free space after layout. Uses space better but makes sizes less faithful.',{dependency:'algorithm!=grid'}),
  'max-growth':scale('common','maxGrowth','Fill gaps: maximum growth',1,3,0.1,'The most a thumbnail may grow while filling gaps.',{dependency:'fill'}),

  'w-size':scale('scoring','wSize','Thumbnail size',0,5,0.1,'How much bigger thumbnails count.'),
  'w-place':scale('scoring','wPlace','Stay in place',0,5,0.1,'Penalty for thumbnails far from where their real window is.'),
  'w-relations':scale('scoring','wRelations','Keep relations',0,5,0.1,'Penalty for windows changing how they sit relative to each other.'),
  'relations-method':combo('scoring','relationsMethod','Relations method',{'Order (left/right, above/below)':'order','Direction (angles)':'direction'},'Order only cares whether windows swap sides; Direction compares the angles between windows and is stricter.'),
  'neighbor-focus':scale('scoring','neighborFocus','Neighbor focus',0,1,0.05,'How much more nearby windows matter than distant ones.',{dependency:'relations-method=direction'}),

  // A plain number, 1 to 100; the extension multiplies by 100 descent steps (its SETTINGS_MAP).
  'optimizer-effort':{...spin('optimizer','steps','Effort',1,100,1,'',
    'How hard the optimizer works. More gives better layouts but takes longer, '+
    'and the more windows there are, the longer it takes. If opening the views '+
    'gets choppy, lower this.'),
    default:D.optimizer.steps/100},

  'push-strength':scale('push','strength','Push strength',0.05,1,0.05,'How far each push moves an overlapping pair.'),
  'push-match-shape':scale('push','matchShape','Match screen shape',0,1,0.05,'Bias pushes toward the screen\'s shape.'),
  'push-polish':sw('push','polish','Polish the result','Final small moves into free space that improve the score.'),

  'scale-enabled':{type:'switch',default:true,description:'Enable Window Spread',
    tooltip:'When off, Cinnamon arranges Show all windows itself.'},
  'expo-enabled':{type:'switch',default:true,description:'Enable Window Spread',
    tooltip:'When off, Cinnamon arranges the windows in Show all workspaces itself.'},
  'expo-algorithm':{type:'combobox',default:'optimizer',description:'Layout algorithm',options:{'Optimizer':'optimizer','Push apart':'push','Ordered rows':'rows','Equal grid':'grid'},
    tooltip:algoTooltip('How windows are arranged inside each workspace.',
      ' Makes even small windows reasonably big, which helps in the small previews.')},
  'expo-margin':{type:'spinbutton',default:14,min:0,max:200,step:2,units:'px',description:'Margin around the edge',
    tooltip:'Empty border inside each workspace preview.'},
  'expo-gap':{type:'spinbutton',default:14,min:0,max:80,step:2,units:'px',description:'Gap between thumbnails',
    tooltip:'Space between windows inside each workspace preview.'},
  // Expo's own copies of the layout settings below; same defaults (engine DEFAULTS), same meaning.
  'expo-fidelity':scale('common','fidelity','Size fidelity',0,1,0.05,'1 keeps true size ratios between windows; 0 gives every thumbnail the same area; values in between compress size differences. Lower values make small windows easier to see in the small previews.',{dependency:'expo-algorithm!=grid'}),
  'expo-max-scale':scale('common','maxScale','Largest thumbnail scale',0.2,1,0.05,'Largest size of a thumbnail compared with its real window; 1 means real size.'),
  'expo-centered':sw('common','centered','Always center the arrangement','When off, the arrangement is moved toward where the real windows are, as far as the preview allows.',{dependency:'expo-algorithm!=grid'}),
  'expo-fill':sw('common','fill','Fill gaps afterwards','Lets thumbnails grow into free space after layout. Uses space better but makes sizes less faithful.',{dependency:'expo-algorithm!=grid'}),
  'expo-max-growth':scale('common','maxGrowth','Fill gaps: maximum growth',1,3,0.1,'The most a thumbnail may grow while filling gaps.',{dependency:'expo-fill'}),

  // A drop-down rather than a spin button: Cinnamon's settings dialog leaves a spin button blank when
  // its value is 0 (it skips setting a value equal to the new widget's initial 0), and 0 means automatic.
  'rows-count':combo('rows','rows','Number of rows',{'Automatic':0,'1 row':1,'2 rows':2,'3 rows':3,'4 rows':4,'5 rows':5,'6 rows':6,'7 rows':7,'8 rows':8},
    'Automatic tries every possible number of rows and uses the one that gives the biggest thumbnails.'),
};
for(const v of Object.values(schema)) if(v.units==='') delete v.units;
// Pages (tabs) and sections of the settings window. Short pages, so the window never needs
// scrolling: scrolling over a slider changes the slider instead (python3-xapp's Range widget).
const layout={type:'layout',pages:['page-general','page-layout','page-expo','page-scoring','page-algorithms'],
  'page-general':{type:'page',title:'General',sections:['sec-general']},
  'page-layout':{type:'page',title:'Show all windows',sections:['sec-scale-enable','sec-layout']},
  'page-expo':{type:'page',title:'Show all workspaces',sections:['sec-expo-enable','sec-expo']},
  'page-scoring':{type:'page',title:'Scoring',sections:['sec-scoring']},
  'page-algorithms':{type:'page',title:'Algorithms',sections:['sec-optimizer','sec-push','sec-rows']},
  'sec-general':{type:'section',title:'General',keys:['use-cache','debug-log']},
  // Each view: the Enable switch in its own section, everything else in a section that is hidden
  // while the switch is off (settings inside can still have their own conditions).
  'sec-scale-enable':{type:'section',title:'Show all windows (Scale)',keys:['scale-enabled']},
  'sec-layout':{type:'section',title:'Arrangement',dependency:'scale-enabled',keys:['algorithm','margin','gap','fidelity','max-scale','centered','fill','max-growth']},
  'sec-scoring':{type:'section',title:'What makes a good layout',keys:['w-size','w-place','w-relations','relations-method','neighbor-focus']},
  'sec-optimizer':{type:'section',title:'Optimizer',keys:['optimizer-effort']},
  'sec-push':{type:'section',title:'Push apart (also a starting point for the optimizer)',keys:['push-strength','push-match-shape','push-polish']},
  'sec-rows':{type:'section',title:'Ordered rows (also a starting point for the optimizer)',keys:['rows-count']},
  'sec-expo-enable':{type:'section',title:'Show all workspaces (Expo)',keys:['expo-enabled']},
  'sec-expo':{type:'section',title:'Arrangement',dependency:'expo-enabled',keys:['expo-algorithm','expo-margin','expo-gap','expo-fidelity','expo-max-scale','expo-centered','expo-fill','expo-max-growth']}};
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
